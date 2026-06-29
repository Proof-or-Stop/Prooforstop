/**
 * Smoke: receipt-bundle ADVERSARIAL tamper-class contract (B-4c65, slice 1).
 *
 * Hermetic — no network, no remote receipt server, no FS/git reads. The smoke:
 *   1. Generates a fresh local ed25519 keypair and builds an AUTHENTIC bundle
 *      from synthetic evidence via buildReceiptBundle.
 *   2. Asserts the authentic bundle is ACCEPTED when verified offline against
 *      the matching current materialHash + the signer's public key — the
 *      CONTROL that proves the verifier is not a vacuous block-everything.
 *   3. For EACH tamper class, deep-clones the authentic bundle, mutates it,
 *      and asserts accepted=false with the EXACT expected reason code.
 *   4. Lying-agent: a 'pass' bundle that is stale (old materialHash) AND one
 *      that is forged (re-signed with a different key) are both REJECTED.
 *   5. Tracks falseAccept (a tamper that got ACCEPTED) and falseReject (the
 *      authentic case REJECTED); asserts BOTH are 0.
 *
 * This tamper matrix is the paper's C2 data proof. assurance is always
 * 'local-key-single-host' — NOT the Authority Tier-C strong proof.
 *
 * Run: node packages/main/dist/tasks/receipt-bundle-contract-smoke.js
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateEd25519KeyPair, signCanonical } from '../core/authority-signing.js';
import {
  buildReceiptBundle,
  verifyReceiptBundleOffline,
  type ReceiptBundle,
  type ReceiptBundleEvidence,
  type ReceiptBundleVerifyReason,
} from '../core/receipt-bundle.js';

// Re-sign a bundle's signature-less view with `privateKey` so a deliberately
// tampered-but-internally-consistent bundle passes the signature check and is
// caught by the LATER semantic check (proves the semantic guards, not just the
// signature, do the rejecting). Mutates and returns the bundle.
function reSign(bundle: ReceiptBundle, privateKey: string): ReceiptBundle {
  const { signature: _drop, ...unsigned } = bundle;
  bundle.signature = signCanonical(unsigned, privateKey);
  return bundle;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// Deep clone via JSON round-trip — the bundle is plain JSON (no functions/Dates).
function clone(bundle: ReceiptBundle): ReceiptBundle {
  return JSON.parse(JSON.stringify(bundle)) as ReceiptBundle;
}

const signer = generateEd25519KeyPair();
const attacker = generateEd25519KeyPair();

// Synthetic DONE-story evidence (shape mirrors done-required-evidence.json).
const CURRENT_MATERIAL = sha256Hex('synthetic-tree@head');
const evidence: ReceiptBundleEvidence = {
  storyId: 'B-SYN1',
  status: 'PASS',
  headHash: sha256Hex('synthetic-head-commit'),
  materialHash: CURRENT_MATERIAL,
  storyFilesHash: sha256Hex('synthetic-story-files'),
  policyHash: sha256Hex('synthetic-policy'),
  commandSetHash: sha256Hex('synthetic-command-set'),
  receipts: [
    { command: 'npm', args: ['--prefix', 'packages/main', 'run', 'build'], label: 'build', exitCode: 0, outputDigest: sha256Hex('build-output') },
    { command: 'npm', args: ['test'], label: 'test', exitCode: 0, outputDigest: sha256Hex('test-output') },
  ],
  hostVerdicts: [
    { hostId: 'host-claude', decision: 'pass', keyId: 'key-claude' },
    { hostId: 'host-codex', decision: 'pass', keyId: 'key-codex' },
  ],
};

const authentic = buildReceiptBundle(evidence, signer.privateKey, signer.publicKey);
const okCtx = { currentMaterialHash: CURRENT_MATERIAL, publicKey: signer.publicKey };

// F-007 self-check: buildReceiptBundle must DERIVE signerPublicKey from the
// signing private key so it equals the keypair's public key (and the trusted
// verifying key). If this drifts, signer_key_mismatch / signature checks below
// would be testing the wrong key.
assert.equal(
  authentic.signerPublicKey,
  signer.publicKey,
  'authentic.signerPublicKey must be the derived public key of the signing private key',
);

let falseAccept = 0;
let falseReject = 0;
const lines: string[] = [];

function matrix(label: string, accepted: boolean, reason: ReceiptBundleVerifyReason): void {
  lines.push(`  [${accepted ? 'ACCEPT' : 'REJECT'}] ${label.padEnd(22)} reason=${reason}`);
}

// --- CONTROL: authentic bundle must be ACCEPTED ----------------------------
{
  const r = verifyReceiptBundleOffline(authentic, okCtx);
  if (!r.accepted) falseReject += 1;
  assert.equal(r.accepted, true, `authentic must be ACCEPTED, got reason=${r.reason}`);
  assert.equal(r.reason, 'ok');
  assert.equal(r.assurance, 'local-key-single-host');
  matrix('authentic (control)', r.accepted, r.reason);
}

// Each tamper case: mutate a clone, expect a precise rejection reason.
interface TamperCase {
  name: string;
  expected: ReceiptBundleVerifyReason;
  // returns [bundle, verify-context] so the case can also vary currentMaterialHash
  build: () => { bundle: ReceiptBundle; ctx: { currentMaterialHash: string; publicKey: string } };
}

const cases: TamperCase[] = [
  // code-byte-flip → the tree changed under the bundle → supply a DIFFERENT
  // currentMaterialHash → stale (the binding caught the code change offline).
  {
    name: 'code-byte-flip',
    expected: 'stale',
    build: () => ({ bundle: clone(authentic), ctx: { currentMaterialHash: sha256Hex('flipped-tree'), publicKey: signer.publicKey } }),
  },
  // evidence-edit → change a receipt's recorded outputDigest after signing →
  // the signed bytes no longer match → signature_invalid.
  {
    name: 'evidence-edit',
    expected: 'signature_invalid',
    build: () => {
      const b = clone(authentic);
      b.receipts[0].outputDigest = sha256Hex('forged-build-output');
      return { bundle: b, ctx: okCtx };
    },
  },
  // host-verdict-swap → flip a host's decision after signing → signature_invalid.
  {
    name: 'host-verdict-swap',
    expected: 'signature_invalid',
    build: () => {
      const b = clone(authentic);
      b.hostVerdicts[1].decision = 'fail';
      return { bundle: b, ctx: okCtx };
    },
  },
  // commandSet-change → mutate binding.commandSetHash after signing →
  // signature_invalid (the binding is inside the signed view).
  {
    name: 'commandSet-change',
    expected: 'signature_invalid',
    build: () => {
      const b = clone(authentic);
      b.binding.commandSetHash = sha256Hex('different-command-set');
      return { bundle: b, ctx: okCtx };
    },
  },
  // stale-materialHash → unchanged bundle, but verify against a mismatched
  // currentMaterialHash → stale.
  {
    name: 'stale-materialHash',
    expected: 'stale',
    build: () => ({ bundle: clone(authentic), ctx: { currentMaterialHash: sha256Hex('some-other-tree'), publicKey: signer.publicKey } }),
  },
  // forged-signature → re-sign the (otherwise authentic) bundle with a
  // DIFFERENT key, verify against the real signer key → signature_invalid.
  {
    name: 'forged-signature',
    expected: 'signature_invalid',
    build: () => {
      const b = clone(authentic);
      const { signature: _s, ...unsigned } = b;
      b.signature = signCanonical(unsigned, attacker.privateKey);
      return { bundle: b, ctx: okCtx };
    },
  },
  // missing-signature → delete the detached signature → signature_missing.
  {
    name: 'missing-signature',
    expected: 'signature_missing',
    build: () => {
      const b = clone(authentic);
      (b as { signature: string }).signature = '';
      return { bundle: b, ctx: okCtx };
    },
  },
  // missing-build-proof → empty the receipts array, then RE-SIGN so the bundle
  // is internally consistent (otherwise we'd fail signature_invalid first):
  // the verifier must still reject on build_proof_missing.
  {
    name: 'missing-build-proof',
    expected: 'build_proof_missing',
    build: () => {
      const empty = buildReceiptBundle({ ...evidence, receipts: [] }, signer.privateKey, signer.publicKey);
      return { bundle: empty, ctx: okCtx };
    },
  },
  // binding-incomplete → blank one binding hash (still a STRING, so strict-shape
  // passes), RE-SIGN with the correct key so the signature is valid → caught by
  // the later binding_incomplete check (an empty hash is an unprovable binding).
  {
    name: 'binding-incomplete',
    expected: 'binding_incomplete',
    build: () => {
      const b = clone(authentic);
      b.binding.policyHash = '';
      return { bundle: reSign(b, signer.privateKey), ctx: okCtx };
    },
  },
  // digest-malformed → corrupt a receipt's outputDigest to a non-hex string,
  // then RE-SIGN with the correct key so it passes signature → caught by the
  // later semantic check as digest_mismatch (F-002/F-003).
  {
    name: 'digest-malformed',
    expected: 'digest_mismatch',
    build: () => {
      const b = clone(authentic);
      b.receipts[0].outputDigest = 'not-a-valid-sha256-hex-digest!!';
      return { bundle: reSign(b, signer.privateKey), ctx: okCtx };
    },
  },
  // decision-not-pass → set decision:'fail', RE-SIGN with the correct key so the
  // signature is valid → caught by the later decision_not_pass check.
  {
    name: 'decision-fail',
    expected: 'decision_not_pass',
    build: () => {
      const b = clone(authentic);
      b.decision = 'fail';
      return { bundle: reSign(b, signer.privateKey), ctx: okCtx };
    },
  },
  // receipt-not-passing (nonzero exit) → decision says 'pass' but a receipt
  // exited 1; RE-SIGN with the correct key so it passes signature → the verifier
  // must REJECT on receipt_not_passing (F-008: a nonzero receipt exit blocks).
  {
    name: 'receipt-exit-1',
    expected: 'receipt_not_passing',
    build: () => {
      const b = clone(authentic);
      assert.equal(b.decision, 'pass');
      b.receipts[1].exitCode = 1;
      return { bundle: reSign(b, signer.privateKey), ctx: okCtx };
    },
  },
  // receipt-not-passing (sentinel exit) → a receipt exited -1 (the build-time
  // "unknown exit" sentinel); RE-SIGN → must REJECT on receipt_not_passing.
  {
    name: 'receipt-exit-neg1',
    expected: 'receipt_not_passing',
    build: () => {
      const b = clone(authentic);
      assert.equal(b.decision, 'pass');
      b.receipts[0].exitCode = -1;
      return { bundle: reSign(b, signer.privateKey), ctx: okCtx };
    },
  },
  // receipt-not-passing (empty command) → a receipt with an empty command,
  // decision 'pass', RE-SIGN → must REJECT on receipt_not_passing (an
  // unidentified command is not a valid build/test proof).
  {
    name: 'receipt-empty-cmd',
    expected: 'receipt_not_passing',
    build: () => {
      const b = clone(authentic);
      assert.equal(b.decision, 'pass');
      b.receipts[0].command = '';
      return { bundle: reSign(b, signer.privateKey), ctx: okCtx };
    },
  },
  // malformed-bundle (null array entry) → push `null` onto hostVerdicts AFTER
  // signing. The canonical signer ELIDES null, so the signature still verifies —
  // the strict-shape guard (F-005) is what must REJECT this as malformed_bundle.
  {
    name: 'hostverdict-null',
    expected: 'malformed_bundle',
    build: () => {
      const b = clone(authentic);
      (b.hostVerdicts as unknown[]).push(null);
      // Intentionally do NOT re-sign: the point is that null is invisible to the
      // signer, so the original signature still verifies; only strict-shape catches it.
      return { bundle: b, ctx: okCtx };
    },
  },
  // malformed-bundle (top-level null) → set a signed field to null after signing.
  // Same elision hole; strict-shape must REJECT as malformed_bundle.
  {
    name: 'decision-null',
    expected: 'malformed_bundle',
    build: () => {
      const b = clone(authentic);
      (b as { decision: unknown }).decision = null;
      return { bundle: b, ctx: okCtx };
    },
  },
  // malformed-bundle (extra top-level key) → inject an unexpected key after
  // signing. The signer elides nothing here, but strict-shape rejects unknown keys.
  {
    name: 'extra-key',
    expected: 'malformed_bundle',
    build: () => {
      const b = clone(authentic);
      (b as unknown as Record<string, unknown>).injected = 'surprise';
      return { bundle: b, ctx: okCtx };
    },
  },
  // signer-key-mismatch → a VALID signature by the trusted key, but the bundle's
  // self-reported signerPublicKey is a DIFFERENT key. Re-sign with the trusted
  // key after swapping signerPublicKey so the signature itself is valid → the
  // verifier must REJECT on signer_key_mismatch (binds key to the verifying key).
  {
    name: 'signer-key-mismatch',
    expected: 'signer_key_mismatch',
    build: () => {
      const b = clone(authentic);
      b.signerPublicKey = attacker.publicKey;
      return { bundle: reSign(b, signer.privateKey), ctx: okCtx };
    },
  },
];

for (const tc of cases) {
  const { bundle, ctx } = tc.build();
  const r = verifyReceiptBundleOffline(bundle, ctx);
  if (r.accepted) falseAccept += 1;
  assert.equal(r.accepted, false, `${tc.name} must be REJECTED but was ACCEPTED`);
  assert.equal(r.reason, tc.expected, `${tc.name}: expected reason=${tc.expected}, got ${r.reason}`);
  assert.equal(r.assurance, 'local-key-single-host');
  matrix(tc.name, r.accepted, r.reason);
}

// --- LYING-AGENT: 'done/pass' claims that are stale OR forged --------------
{
  // (a) the agent says pass, but its evidence is stale (old materialHash).
  const stale = clone(authentic);
  assert.equal(stale.decision, 'pass');
  const rStale = verifyReceiptBundleOffline(stale, { currentMaterialHash: sha256Hex('moved-on-tree'), publicKey: signer.publicKey });
  if (rStale.accepted) falseAccept += 1;
  assert.equal(rStale.accepted, false);
  assert.equal(rStale.reason, 'stale');
  console.log(`  [lying-agent] stale done/pass REJECTED reason=${rStale.reason}`);

  // (b) the agent says pass, but the signature is forged with a wrong key.
  const forged = clone(authentic);
  assert.equal(forged.decision, 'pass');
  const { signature: _s2, ...unsignedForged } = forged;
  forged.signature = signCanonical(unsignedForged, attacker.privateKey);
  const rForged = verifyReceiptBundleOffline(forged, okCtx);
  if (rForged.accepted) falseAccept += 1;
  assert.equal(rForged.accepted, false);
  assert.equal(rForged.reason, 'signature_invalid');
  console.log(`  [lying-agent] forged done/pass REJECTED reason=${rForged.reason}`);
}

// --- INDEPENDENT SELF-CHECK: the two soundness holes Codex found ------------
// Asserted standalone (not via the case table) so a future edit to the table
// can never silently drop coverage of these specific holes.
{
  // Hole #1 (F-008): a signed 'pass' bundle whose receipt exited 1 must REJECT.
  const exit1 = clone(authentic);
  assert.equal(exit1.decision, 'pass');
  exit1.receipts[0].exitCode = 1;
  reSign(exit1, signer.privateKey); // valid signature → must be caught semantically
  const rExit1 = verifyReceiptBundleOffline(exit1, okCtx);
  assert.equal(rExit1.accepted, false, 'HOLE: receipt exitCode:1 was ACCEPTED');
  assert.equal(rExit1.reason, 'receipt_not_passing');

  // Hole #2 (F-005): hostVerdicts.push(null) AFTER signing must REJECT even
  // though the canonical signer elides null and the original signature verifies.
  const nullVerdict = clone(authentic);
  (nullVerdict.hostVerdicts as unknown[]).push(null);
  const rNull = verifyReceiptBundleOffline(nullVerdict, okCtx);
  assert.equal(rNull.accepted, false, 'HOLE: hostVerdicts.push(null) was ACCEPTED');
  assert.equal(rNull.reason, 'malformed_bundle');
  console.log(`  [self-check] receipt exitCode:1 REJECTED reason=${rExit1.reason}; hostVerdicts.push(null) REJECTED reason=${rNull.reason}`);
}

// --- COVERAGE: the tamper matrix must reach EVERY non-ok reason code --------
const ALL_REASONS: ReceiptBundleVerifyReason[] = [
  'malformed_bundle',
  'binding_incomplete',
  'stale',
  'signature_missing',
  'signer_key_mismatch',
  'signature_invalid',
  'digest_mismatch',
  'receipt_not_passing',
  'build_proof_missing',
  'decision_not_pass',
];
const reached = new Set<ReceiptBundleVerifyReason>(cases.map(c => c.expected));
const unreached = ALL_REASONS.filter(r => !reached.has(r));
assert.equal(unreached.length, 0, `tamper matrix does not reach reason code(s): ${unreached.join(', ')}`);

const N = cases.length;
for (const line of lines) console.log(line);

assert.equal(falseReject, 0, `expected 0 false-reject, got ${falseReject}`);
assert.equal(falseAccept, 0, `expected 0 false-accept, got ${falseAccept}`);

if (falseAccept !== 0 || falseReject !== 0) {
  process.exitCode = 1;
} else {
  console.log('✓ receipt-bundle contract smoke passed: authentic ACCEPTED; ' + N + ' tamper classes REJECTED (every reason code reached); lying-agent + soundness-hole self-checks rejected; 0 false-accept, 0 false-reject');
}
