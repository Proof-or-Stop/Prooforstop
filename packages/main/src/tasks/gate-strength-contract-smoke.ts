/**
 * Smoke: gate-strength self-red-team contract (B-7b6e, capability 🥈 slice 1).
 *
 * Hermetic — no network, no agent/review-lane dispatch, no FS/git reads. The smoke proves:
 *   1. testOnlyReviewer (trusts only the visible test) → catchRate 0, falseShip = wrongTotal:
 *      it ships EVERY passes-the-visible-test-but-wrong probe. The "green test = correct" gap.
 *   2. blockAllReviewer (blocks everything) → catchRate 1.0 BUT falseBlock = genuineTotal:
 *      catch-rate alone is gameable, so it must be read together with falseBlock.
 *   3. oracleReviewer (reads the defect label) → catchRate 1.0, falseBlock 0: it DOMINATES both
 *      endpoints (beats test-only on catchRate AND beats block-all on falseBlock). Only a reviewer
 *      that wins on BOTH axes shows real discrimination — that is the non-vacuity proof.
 *   4. runGateStrength REJECTS a corpus with no wrong probes (no vacuous 0/0 = 1.0 "perfect").
 *   5. gateStrengthBundle(result) → a B-4c65 ReceiptBundle that verifyReceiptBundleOffline ACCEPTS;
 *      a stale materialHash or a tampered signed field is REJECTED (the bundle is tamper-evident).
 *   6. verifyGateStrengthResult closes the result↔receipt loop: the authentic result MATCHES the
 *      bound digest; a result tampered after the fact (inflated catchRate) does NOT match.
 *
 * assurance is always 'local-key-single-host' (inherited from B-4c65) — NOT an Authority Tier-C
 * strong proof. The reviewers here are REFERENCE endpoints/oracle; a live claude -p review lane
 * (a follow-up) reads the artifact and plugs into the same Reviewer seam.
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
  verifyGateStrengthResult,
  testOnlyReviewer,
  blockAllReviewer,
  oracleReviewer,
  STANDING_CORPUS,
  type Probe,
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

// ── 1. catches nothing: a test-only reviewer ships every wrong-but-test-passing probe ──
const testOnly = runGateStrength(testOnlyReviewer);
check('test-only reviewer: catchRate 0, falseShip = wrongTotal (ships every wrong probe)', () => {
  assert.equal(testOnly.catchRate, 0, `expected 0, got ${testOnly.catchRate}`);
  assert.equal(testOnly.caught, 0);
  assert.equal(testOnly.falseShip, wrongTotal);
  assert.equal(testOnly.falseBlock, 0);
});

// ── 2. catchRate is gameable: block-everything also scores 1.0, but over-blocks ──
const blockAll = runGateStrength(blockAllReviewer);
check('block-all reviewer: catchRate 1.0 BUT falseBlock = genuineTotal (catchRate alone is gameable)', () => {
  assert.equal(blockAll.catchRate, 1, `expected 1.0, got ${blockAll.catchRate}`);
  assert.equal(blockAll.falseBlock, genuineTotal, `expected falseBlock ${genuineTotal}`);
});

// ── 3. the oracle DOMINATES both endpoints — the real non-vacuity proof ──
const oracle = runGateStrength(oracleReviewer);
check('oracle reviewer: catchRate 1.0, falseShip 0, falseBlock 0, names each defect', () => {
  assert.equal(oracle.catchRate, 1, `expected 1.0, got ${oracle.catchRate}`);
  assert.equal(oracle.caught, wrongTotal);
  assert.equal(oracle.falseShip, 0);
  assert.equal(oracle.falseBlock, 0);
  for (const o of oracle.perProbe) {
    if (o.classification === 'caught') {
      assert.ok(o.reason.includes(o.defectKind), `reason for ${o.id} omits defect kind ${o.defectKind}: ${o.reason}`);
    }
  }
  const genuine = oracle.perProbe.find((o) => o.id === 'genuine');
  assert.ok(genuine && genuine.classification === 'shipped-genuine', 'oracle must ship the genuine probe');
});
check('oracle DOMINATES: beats test-only on catchRate AND beats block-all on falseBlock', () => {
  // catchRate alone cannot distinguish the oracle from block-all — falseBlock is what separates them.
  assert.ok(oracle.catchRate > testOnly.catchRate, 'oracle must out-catch the test-only reviewer');
  assert.ok(oracle.falseBlock < blockAll.falseBlock, 'oracle must over-block strictly less than block-all');
  assert.equal(blockAll.catchRate, oracle.catchRate, 'catchRate alone is intentionally indistinguishable here');
});

// ── 4. a corpus with no wrong probes is rejected (no vacuous 0/0 = 1.0) ──
check('runGateStrength REJECTS an all-genuine corpus (catch-rate is undefined)', () => {
  const allGenuine: Probe[] = [
    { id: 'g1', description: 'genuine', artifact: 'ok', visibleAcceptancePass: true, groundTruthPass: true, defectKind: 'none' },
  ];
  assert.throws(() => runGateStrength(oracleReviewer, allGenuine), /no wrong probes/);
});
check('runGateStrength REJECTS a corpus that violates the defectKind<->genuine invariant', () => {
  const bad: Probe[] = [
    { id: 'b1', description: 'mislabeled', artifact: 'x', visibleAcceptancePass: true, groundTruthPass: false, defectKind: 'none' },
    { id: 'g1', description: 'genuine', artifact: 'ok', visibleAcceptancePass: true, groundTruthPass: true, defectKind: 'none' },
  ];
  assert.throws(() => runGateStrength(oracleReviewer, bad), /corpus invariant violated/);
});

// ── 5. the published metric is offline-verifiable + tamper-evident (composes 🥇) ──
const signer = generateEd25519KeyPair();
const binding: ReceiptBundleBinding = {
  headHash: sha256Hex('head'),
  materialHash: sha256Hex('material'),
  storyFilesHash: sha256Hex('storyFiles'),
  policyHash: sha256Hex('policy'),
  commandSetHash: sha256Hex('commandSet'),
};
const bundle = gateStrengthBundle(oracle, 'oracle', binding, signer.privateKey);
check('gate-strength receipt verifies offline (ACCEPTED) against matching materialHash', () => {
  const r = verifyReceiptBundleOffline(bundle, { currentMaterialHash: binding.materialHash, publicKey: signer.publicKey });
  assert.ok(r.accepted, `expected accepted, got ${r.reason}`);
  assert.equal(r.assurance, 'local-key-single-host');
});
check('tampering a signed bundle field is REJECTED (signature_invalid)', () => {
  const tampered = clone(bundle);
  assert.equal(tampered.receipts.length, 1, 'gateStrengthBundle must emit exactly one receipt');
  tampered.receipts[0]!.outputDigest = sha256Hex('a-different-metric-result');
  const r = verifyReceiptBundleOffline(tampered, { currentMaterialHash: binding.materialHash, publicKey: signer.publicKey });
  assert.equal(r.accepted, false, 'a tampered receipt must not verify');
  assert.equal(r.reason, 'signature_invalid');
});
check('a stale receipt (old materialHash) is REJECTED', () => {
  const r = verifyReceiptBundleOffline(bundle, { currentMaterialHash: sha256Hex('some-newer-tree'), publicKey: signer.publicKey });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'stale');
});

// ── 6. close the result↔receipt loop: a result tampered after the fact does NOT match ──
check('verifyGateStrengthResult: the authentic result MATCHES the bound digest', () => {
  const m = verifyGateStrengthResult(oracle, bundle);
  assert.ok(m.matches, `expected match; expected=${m.expectedDigest} bound=${m.boundDigest}`);
});
check('verifyGateStrengthResult: a result tampered after the fact does NOT match the receipt', () => {
  const forged = { ...oracle, catchRate: 1, caught: oracle.caught, falseBlock: 99 }; // lie about over-blocking
  const m = verifyGateStrengthResult(forged, bundle);
  assert.equal(m.matches, false, 'a forged result must not match the bound digest');
});

if (failures.length > 0) {
  console.error(`\n✗ gate-strength contract smoke FAILED (${failures.length}):`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(
  `\n✓ gate-strength contract smoke passed: test-only caught 0/${wrongTotal} (visible-test gap), ` +
    `block-all catchRate 1.0 but falseBlock ${genuineTotal} (catchRate gameable), ` +
    `oracle DOMINATES both (catchRate 1.0 + falseBlock 0), all-genuine/invalid corpus rejected, ` +
    `receipt verifies offline + tamper-evident, result↔receipt loop closed.`,
);
