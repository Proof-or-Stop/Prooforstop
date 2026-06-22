/**
 * Smoke: gate-strength self-red-team contract (B-7b6e, capability 🥈 slice 1).
 *
 * Hermetic — no network, no agent/review-lane dispatch, no FS/git reads. The smoke:
 *   1. testOnlyReviewer (trusts only the visible test) → catchRate 0: it ships EVERY
 *      passes-the-visible-test-but-wrong probe (falseShip = wrongTotal). This is the
 *      "green test = correct" fallacy made concrete — the lower bound.
 *   2. specAwareReviewer (detects the defect) → catchRate 1.0: it blocks every wrong
 *      probe with a reason naming the defect AND ships the genuine one (falseBlock 0).
 *      The upper bound.
 *   3. The two endpoints DIFFER (0 vs 1.0) → the metric is non-vacuous: it measures real
 *      discrimination, not a constant block-everything / ship-everything.
 *   4. gateStrengthBundle(spec-aware result) → a B-4c65 ReceiptBundle that
 *      verifyReceiptBundleOffline ACCEPTS against the matching materialHash + public key.
 *   5. Tamper: flip the published metric's bound digest → the bundle is REJECTED
 *      (signature_invalid). The gate-strength metric is itself tamper-evident.
 *
 * assurance is always 'local-key-single-host' (inherited from B-4c65) — NOT an Authority
 * Tier-C strong proof. The reviewers here are REFERENCE endpoints; a live claude -p review
 * lane (a follow-up) plugs into the same Reviewer seam and lands between them.
 *
 * Run: node packages/main/dist/tasks/gate-strength-contract-smoke.js
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateEd25519KeyPair } from '../core/authority-signing.js';
import { verifyReceiptBundleOffline, type ReceiptBundle, type ReceiptBundleBinding } from '../core/receipt-bundle.js';
import {
  runGateStrength,
  gateStrengthBundle,
  testOnlyReviewer,
  specAwareReviewer,
  STANDING_CORPUS,
} from '../core/gate-strength.js';

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function clone(bundle: ReceiptBundle): ReceiptBundle {
  return JSON.parse(JSON.stringify(bundle)) as ReceiptBundle;
}

const failures: string[] = [];
function check(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}: ${(err as Error).message}`);
    console.log(`  ✗ ${label}`);
  }
}

const wrongTotal = STANDING_CORPUS.filter((p) => !p.groundTruthPass).length; // 3
const genuineTotal = STANDING_CORPUS.length - wrongTotal; // 1

// ── 1. lower bound: a test-only reviewer catches NOTHING ───────────────────────
const testOnly = runGateStrength(testOnlyReviewer);
check('test-only reviewer: catchRate 0 (ships every wrong-but-test-passing probe)', () => {
  assert.equal(testOnly.catchRate, 0, `expected 0, got ${testOnly.catchRate}`);
  assert.equal(testOnly.caught, 0);
  assert.equal(testOnly.falseShip, wrongTotal, `expected falseShip ${wrongTotal}`);
  // it still ships the genuine one (no over-blocking) — it just can't discriminate.
  assert.equal(testOnly.falseBlock, 0);
});

// ── 2. upper bound: a spec-aware reviewer catches ALL wrong, ships the genuine ──
const specAware = runGateStrength(specAwareReviewer);
check('spec-aware reviewer: catchRate 1.0, falseShip 0, falseBlock 0', () => {
  assert.equal(specAware.catchRate, 1, `expected 1.0, got ${specAware.catchRate}`);
  assert.equal(specAware.caught, wrongTotal);
  assert.equal(specAware.falseShip, 0);
  assert.equal(specAware.falseBlock, 0);
});
check('spec-aware reviewer: each caught probe names its defect kind in the reason', () => {
  for (const o of specAware.perProbe) {
    if (o.classification === 'caught') {
      assert.ok(o.reason.includes(o.defectKind), `reason for ${o.id} omits defect kind ${o.defectKind}: ${o.reason}`);
    }
  }
  // the genuine probe is shipped, not blocked.
  const genuine = specAware.perProbe.find((o) => o.id === 'genuine');
  assert.ok(genuine && genuine.classification === 'shipped-genuine', 'genuine probe was not shipped');
});

// ── 3. the metric is non-vacuous: the two endpoints DIFFER ─────────────────────
check('endpoints differ (0 vs 1.0) → metric measures real discrimination, not a constant', () => {
  assert.notEqual(testOnly.catchRate, specAware.catchRate);
  assert.ok(genuineTotal >= 1, 'corpus must contain at least one genuine control');
});

// ── 4. the published metric is offline-verifiable (composes 🥇) ─────────────────
const signer = generateEd25519KeyPair();
const binding: ReceiptBundleBinding = {
  headHash: sha256Hex('head'),
  materialHash: sha256Hex('material'),
  storyFilesHash: sha256Hex('storyFiles'),
  policyHash: sha256Hex('policy'),
  commandSetHash: sha256Hex('commandSet'),
};
const bundle = gateStrengthBundle(specAware, 'spec-aware', binding, signer.privateKey);
check('gate-strength receipt verifies offline (ACCEPTED) against matching materialHash', () => {
  const r = verifyReceiptBundleOffline(bundle, {
    currentMaterialHash: binding.materialHash,
    publicKey: signer.publicKey,
  });
  assert.ok(r.accepted, `expected accepted, got ${r.reason}`);
  assert.equal(r.assurance, 'local-key-single-host');
});

// ── 5. the published metric is tamper-evident ──────────────────────────────────
check('tampering the bound metric digest is REJECTED (signature_invalid)', () => {
  const tampered = clone(bundle);
  tampered.receipts[0]!.outputDigest = sha256Hex('a-different-metric-result');
  const r = verifyReceiptBundleOffline(tampered, {
    currentMaterialHash: binding.materialHash,
    publicKey: signer.publicKey,
  });
  assert.equal(r.accepted, false, 'a tampered metric digest must not verify');
  assert.equal(r.reason, 'signature_invalid');
});
check('a stale receipt (old materialHash) is REJECTED', () => {
  const r = verifyReceiptBundleOffline(bundle, {
    currentMaterialHash: sha256Hex('some-newer-tree'),
    publicKey: signer.publicKey,
  });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'stale');
});

if (failures.length > 0) {
  console.error(`\n✗ gate-strength contract smoke FAILED (${failures.length}):`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(
  `\n✓ gate-strength contract smoke passed: test-only caught 0/${wrongTotal} (visible-test gap), ` +
    `spec-aware caught ${specAware.caught}/${wrongTotal} with correct reasons (discrimination real), ` +
    `endpoints differ (0≠1.0), gate-strength receipt verifies offline + is tamper-evident.`,
);
