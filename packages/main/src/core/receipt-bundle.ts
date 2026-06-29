// Portable offline-verifiable receipt bundle (B-4c65, capability slice 1).
//
// A `ReceiptBundle` is a self-contained, local-key/ed25519-SIGNED snapshot of a
// story's gate evidence (binding hashes + receipt identities + host verdicts +
// decision) that can be carried to another machine and VERIFIED OFFLINE — no
// network, no Authority server, no filesystem reads inside the verifier.
//
// HONEST SCOPE LABEL (read this before citing the result anywhere):
//   assurance === 'local-key-single-host'.
//   This is a single-host, local-key signature. It proves "these bytes were
//   signed by the holder of this key and were not tampered with after signing,
//   and the bundle's materialHash matches the current tree" — it is NOT the
//   Authority Tier-C strong proof (which requires an independent Authority
//   server's receipt over a 2-host quorum). Authority integration is DEFERRED.
//   Do not claim receipt-bundle verification or retired completion fields from a
//   local-key bundle. See authority-boundary.ts for the L2+ classifier.
//
// Crypto reuse: this module does NOT reimplement any crypto. It reuses
// signCanonical / verifyCanonical / canonicalDigest from authority-signing.ts
// (deterministic canonical-JSON ed25519). Signing is over the signature-less
// canonical form.
//
// IMPORTANT — defense against the canonical signer eliding values:
//   The shared canonical signer (normalizeSigningJson in authority-signing.ts)
//   intentionally OMITS `undefined` AND `null` (and null array entries). That
//   means a `null` injected into the bundle AFTER signing (e.g.
//   hostVerdicts.push(null)) is NOT covered by the signature and would still
//   verifyCanonical → true. To close that hole the verifier runs a STRICT
//   structural validation (assertStrictBundleShape) that REJECTS any null,
//   wrong type, missing field, or unexpected top-level key BEFORE accepting.
//   We also bind signerPublicKey to the trusted verifying key (the signature is
//   checked against context.publicKey, NOT the bundle's self-reported key).

import { createPublicKey } from 'node:crypto';
import {
  signCanonical,
  verifyCanonical,
  importPrivateKeyRaw,
  exportPublicKeyRaw,
  type PrivateKeyBase64,
  type PublicKeyBase64,
  type SignatureBase64,
} from './authority-signing.js';

export const RECEIPT_BUNDLE_SCHEMA_VERSION = 'lattice.receipt_bundle.v1' as const;

/** The only assurance level a local-key/single-host bundle can ever carry. */
export type ReceiptBundleAssurance = 'local-key-single-host';

/** The binding chain — every field must be a non-empty hash for the bundle to verify. */
export interface ReceiptBundleBinding {
  headHash: string;
  materialHash: string;
  storyFilesHash: string;
  policyHash: string;
  commandSetHash: string;
}

/** One executed gate command's identity (NOT the raw output — only its digest). */
export interface ReceiptBundleReceipt {
  command: string;
  exitCode: number;
  outputDigest: string;
  /** Optional human label, carried for audit; bound into the signature when present. */
  label?: string;
}

/** One host's review/test verdict over the bundle. */
export interface ReceiptBundleHostVerdict {
  hostId: string;
  decision: string;
  keyId: string;
}

export type ReceiptBundleDecision = 'pass' | 'fail' | 'blocked';

export interface ReceiptBundle {
  schemaVersion: typeof RECEIPT_BUNDLE_SCHEMA_VERSION;
  storyId: string;
  binding: ReceiptBundleBinding;
  receipts: ReceiptBundleReceipt[];
  hostVerdicts: ReceiptBundleHostVerdict[];
  decision: ReceiptBundleDecision;
  assurance: ReceiptBundleAssurance;
  /** Echo of the signing key (base64/hex), bound into the signature. */
  signerPublicKey: PublicKeyBase64;
  /** Detached ed25519 signature (base64) over the signature-less canonical form. */
  signature: SignatureBase64;
}

/**
 * Shape of the local evidence object a bundle is assembled from. Mirrors the
 * keys of a done-required-evidence.json (status/headHash/materialHash/
 * storyFilesHash/policyHash/commandSetHash + receipts[]) plus the host verdicts
 * the caller has on hand. Extra keys are ignored.
 */
export interface ReceiptBundleEvidence {
  storyId: string;
  status?: string;
  headHash?: string;
  materialHash?: string;
  storyFilesHash?: string;
  policyHash?: string;
  commandSetHash?: string;
  decision?: ReceiptBundleDecision;
  receipts?: Array<{
    command?: string;
    args?: string[];
    label?: string;
    exitCode?: number;
    outputDigest?: string;
  }>;
  hostVerdicts?: ReceiptBundleHostVerdict[];
}

export type ReceiptBundleVerifyReason =
  | 'ok'
  | 'malformed_bundle'
  | 'binding_incomplete'
  | 'stale'
  | 'signature_missing'
  | 'signer_key_mismatch'
  | 'signature_invalid'
  | 'digest_mismatch'
  | 'receipt_not_passing'
  | 'build_proof_missing'
  | 'decision_not_pass';

export interface ReceiptBundleVerifyResult {
  accepted: boolean;
  reason: ReceiptBundleVerifyReason;
  assurance: ReceiptBundleAssurance;
}

export interface ReceiptBundleVerifyContext {
  /** The verifier's freshly-recomputed materialHash of the current tree. */
  currentMaterialHash: string;
  /** The trusted local public key the signature must verify against. */
  publicKey: PublicKeyBase64;
}

/** A hex sha256 digest is 64 lowercase/uppercase hex chars; reject empty / malformed. */
const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** A real, finite integer (exitCode must be an integer, not 1.5 / NaN / Infinity). */
function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

const VALID_DECISIONS: ReadonlySet<string> = new Set(['pass', 'fail', 'blocked']);

/** The exhaustive set of allowed top-level keys on a ReceiptBundle. */
const ALLOWED_BUNDLE_KEYS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'storyId',
  'binding',
  'receipts',
  'hostVerdicts',
  'decision',
  'assurance',
  'signerPublicKey',
  'signature',
]);
const ALLOWED_BINDING_KEYS: ReadonlySet<string> = new Set([
  'headHash',
  'materialHash',
  'storyFilesHash',
  'policyHash',
  'commandSetHash',
]);
const ALLOWED_RECEIPT_KEYS: ReadonlySet<string> = new Set([
  'command',
  'exitCode',
  'outputDigest',
  'label',
]);
const ALLOWED_HOST_VERDICT_KEYS: ReadonlySet<string> = new Set([
  'hostId',
  'decision',
  'keyId',
]);

/** A plain object (not null, not array). Rejects `null` explicitly. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True iff `obj` carries no key outside `allowed` (rejects unexpected/extra keys). */
function hasOnlyAllowedKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

/**
 * STRICT structural validation of a ReceiptBundle (F-005 defense).
 *
 * The shared canonical signer (normalizeSigningJson) OMITS `undefined` and
 * `null` (including null array entries), so a `null` injected AFTER signing is
 * invisible to the signature and would still verifyCanonical → true. This
 * validator runs BEFORE the bundle can be accepted and REJECTS:
 *   - any missing field, or any field of the wrong type,
 *   - ANY `null` anywhere (top-level, binding, receipts, hostVerdicts —
 *     including a `null` entry pushed onto an array),
 *   - any unexpected/extra top-level (or nested) key,
 *   - a decision outside the {pass,fail,blocked} union.
 *
 * Order-independent: it may run before or after the signature check. Returns
 * true iff the shape is strictly well-formed.
 */
function isStrictBundleShape(bundle: unknown): bundle is ReceiptBundle {
  if (!isPlainObject(bundle)) return false;
  if (!hasOnlyAllowedKeys(bundle, ALLOWED_BUNDLE_KEYS)) return false;

  if (bundle.schemaVersion !== RECEIPT_BUNDLE_SCHEMA_VERSION) return false;
  if (!nonEmptyString(bundle.storyId)) return false;
  if (bundle.assurance !== 'local-key-single-host') return false;
  if (!nonEmptyString(bundle.signerPublicKey)) return false;
  // signature must be a STRING (never null/missing) — its emptiness is the
  // dedicated signature_missing check, so that reason stays distinctly reachable.
  if (typeof bundle.signature !== 'string') return false;
  if (typeof bundle.decision !== 'string' || !VALID_DECISIONS.has(bundle.decision)) return false;

  // binding — a plain object, no extra keys, every hash a STRING (never null).
  // Emptiness of a hash is handled by the dedicated binding_incomplete check so
  // that reason stays distinctly reachable; here we only enforce shape/type.
  const binding = bundle.binding;
  if (!isPlainObject(binding)) return false;
  if (!hasOnlyAllowedKeys(binding, ALLOWED_BINDING_KEYS)) return false;
  for (const k of ALLOWED_BINDING_KEYS) {
    if (typeof binding[k] !== 'string') return false;
  }

  // receipts — a real array, every entry a strict receipt object (no null entry).
  // command / outputDigest must be STRINGS (never null) and exitCode an integer;
  // emptiness/non-passing semantics are the dedicated receipt_not_passing /
  // digest_mismatch checks so those reasons stay distinctly reachable.
  if (!Array.isArray(bundle.receipts)) return false;
  for (const receipt of bundle.receipts) {
    if (!isPlainObject(receipt)) return false; // rejects a null entry
    if (!hasOnlyAllowedKeys(receipt, ALLOWED_RECEIPT_KEYS)) return false;
    if (typeof receipt.command !== 'string') return false;
    if (!isInteger(receipt.exitCode)) return false;
    if (typeof receipt.outputDigest !== 'string') return false;
    if (Object.prototype.hasOwnProperty.call(receipt, 'label') && !nonEmptyString(receipt.label)) return false;
  }

  // hostVerdicts — a real array, every entry a strict verdict object (no null entry).
  if (!Array.isArray(bundle.hostVerdicts)) return false;
  for (const verdict of bundle.hostVerdicts) {
    if (!isPlainObject(verdict)) return false; // rejects a null entry (the F-005 hole)
    if (!hasOnlyAllowedKeys(verdict, ALLOWED_HOST_VERDICT_KEYS)) return false;
    if (!nonEmptyString(verdict.hostId)) return false;
    if (!nonEmptyString(verdict.decision)) return false;
    if (!nonEmptyString(verdict.keyId)) return false;
  }

  return true;
}

/**
 * The signature-less view of a bundle: everything EXCEPT the detached
 * `signature`. signerPublicKey is intentionally retained so a key swap changes
 * the signed bytes too — but key binding is enforced primarily by comparing
 * bundle.signerPublicKey to the trusted context.publicKey (signer_key_mismatch)
 * and verifying the signature against context.publicKey (not the self-report).
 */
function unsignedView(bundle: ReceiptBundle): Omit<ReceiptBundle, 'signature'> {
  const { signature: _signature, ...rest } = bundle;
  return rest;
}

/**
 * Derive the raw base64 Ed25519 public key that corresponds to `privateKey`
 * (F-007). The bundle's signerPublicKey MUST be the actual public key of the
 * signing private key — never a caller-supplied value that could mismatch.
 */
function publicKeyForPrivateKey(privateKey: PrivateKeyBase64): PublicKeyBase64 {
  const priv = importPrivateKeyRaw(privateKey);
  return exportPublicKeyRaw(createPublicKey(priv));
}

/**
 * Assemble a canonical ReceiptBundle from a local evidence object and sign it
 * with a local ed25519 private key (raw base64). The returned bundle carries a
 * detached signature over its signature-less canonical form.
 *
 * NO network/server/fs access. assurance is hardwired to
 * 'local-key-single-host' — this function cannot mint an Authority proof.
 *
 * F-007: the bundle's signerPublicKey is DERIVED from `privateKey`, never taken
 * from a caller-supplied value. The optional `signerPublicKey` parameter is
 * retained for source compatibility but is ignored for the binding — the bundle
 * always reports the actual public key of the signing key, so a verifier can
 * safely require bundle.signerPublicKey === trusted publicKey.
 */
export function buildReceiptBundle(
  evidence: ReceiptBundleEvidence,
  privateKey: PrivateKeyBase64,
  _signerPublicKey?: PublicKeyBase64,
): ReceiptBundle {
  const binding: ReceiptBundleBinding = {
    headHash: evidence.headHash ?? '',
    materialHash: evidence.materialHash ?? '',
    storyFilesHash: evidence.storyFilesHash ?? '',
    policyHash: evidence.policyHash ?? '',
    commandSetHash: evidence.commandSetHash ?? '',
  };

  const receipts: ReceiptBundleReceipt[] = (evidence.receipts ?? []).map((r) => {
    // The bundle's "command" is the full invocation identity (command + args)
    // so two different commands with the same binary never collide.
    const command = [r.command, ...(r.args ?? [])].filter(nonEmptyString).join(' ');
    const receipt: ReceiptBundleReceipt = {
      command,
      exitCode: typeof r.exitCode === 'number' ? r.exitCode : -1,
      outputDigest: r.outputDigest ?? '',
    };
    if (nonEmptyString(r.label)) receipt.label = r.label;
    return receipt;
  });

  // Decision must be a member of the {pass,fail,blocked} union. A non-PASS
  // status (or any unrecognized status) collapses to 'fail' rather than an
  // arbitrary free-text string, so the bundle never carries an off-union value.
  const decision: ReceiptBundleDecision =
    evidence.decision
    ?? (evidence.status && evidence.status.toUpperCase() === 'PASS' ? 'pass' : 'fail');

  // F-007: bind the ACTUAL public key of the signing private key.
  const signerPublicKey = publicKeyForPrivateKey(privateKey);

  const unsigned: Omit<ReceiptBundle, 'signature'> = {
    schemaVersion: RECEIPT_BUNDLE_SCHEMA_VERSION,
    storyId: evidence.storyId,
    binding,
    receipts,
    hostVerdicts: evidence.hostVerdicts ?? [],
    decision,
    assurance: 'local-key-single-host',
    signerPublicKey,
  };

  const signature = signCanonical(unsigned, privateKey);
  return { ...unsigned, signature };
}

/**
 * Offline-verify a ReceiptBundle. Returns a single ordered verdict with a
 * distinct reason code. NO network/server/fs access anywhere in this function.
 *
 * Check order (each short-circuits with its own reason):
 *   1. malformed_bundle     — STRICT structural validation (F-005). Rejects any
 *                             null (incl. a null array entry), wrong type,
 *                             missing field, unexpected/extra key, or off-union
 *                             decision. Order-independent → runs FIRST, before
 *                             any signed field is trusted. This closes the hole
 *                             where the canonical signer elides null values.
 *   2. signer_key_mismatch  — bundle.signerPublicKey !== trusted context.publicKey
 *                             (F-007). The signature is then verified against
 *                             context.publicKey, never the bundle self-report.
 *   3. signature_missing     — no detached signature on the bundle.
 *   4. signature_invalid     — verifyCanonical over the signature-less view fails
 *                             against the TRUSTED key (forged/wrong-key/tamper).
 *   --- below here the signature is verified; semantic checks (F-006) ---
 *   5. binding_incomplete    — any binding hash empty.
 *   6. stale                 — binding.materialHash !== currentMaterialHash.
 *   7. digest_mismatch       — a receipt's outputDigest is malformed/non-hex.
 *   8. receipt_not_passing   — a receipt has empty command, exitCode !== 0, or a
 *                             non-sha256 outputDigest (F-008).
 *   9. build_proof_missing   — no receipt present at all (no build/test proof).
 *  10. decision_not_pass     — decision !== 'pass'.
 * accepted=true only when ALL checks pass.
 */
export function verifyReceiptBundleOffline(
  bundle: ReceiptBundle,
  context: ReceiptBundleVerifyContext,
): ReceiptBundleVerifyResult {
  const assurance: ReceiptBundleAssurance = 'local-key-single-host';
  const reject = (reason: ReceiptBundleVerifyReason): ReceiptBundleVerifyResult => ({
    accepted: false,
    reason,
    assurance,
  });

  // 1. malformed_bundle — STRICT structural validation (F-005). This MUST pass
  //    before any signed field is interpreted, because the canonical signer
  //    elides null (incl. null array entries) — so a null injected after signing
  //    is invisible to the signature. Rejecting all null / wrong-type / missing
  //    / extra-key / off-union shapes here defends against any elided value.
  if (!isStrictBundleShape(bundle)) {
    return reject('malformed_bundle');
  }

  // 2. signer_key_mismatch — the bundle's self-reported signerPublicKey must be
  //    the trusted verifying key (F-007). We verify the signature against the
  //    TRUSTED context.publicKey below, never against the bundle's self-report,
  //    so a bundle signed by the trusted key but carrying a different
  //    signerPublicKey is rejected here rather than silently accepted.
  if (bundle.signerPublicKey !== context.publicKey) {
    return reject('signer_key_mismatch');
  }

  // 3. signature_missing — a detached signature must be present.
  if (!nonEmptyString(bundle.signature)) {
    return reject('signature_missing');
  }

  // 4. signature_invalid — the signature must verify against the TRUSTED local
  //    key (context.publicKey) over the signature-less canonical view. Any
  //    post-sign mutation to receipts / hostVerdicts / binding / decision /
  //    signerPublicKey, OR a forged signature (re-signed with a different key),
  //    fails here. F-006: no semantic reason is returned for a bad signature.
  if (!verifyCanonical(unsignedView(bundle), bundle.signature, context.publicKey)) {
    return reject('signature_invalid');
  }

  // ---- The signature is now verified; the signed fields are trustworthy. ----

  // 5. binding_incomplete — every binding hash must be a non-empty string.
  const binding = bundle.binding;
  if (
    !nonEmptyString(binding.headHash)
    || !nonEmptyString(binding.materialHash)
    || !nonEmptyString(binding.storyFilesHash)
    || !nonEmptyString(binding.policyHash)
    || !nonEmptyString(binding.commandSetHash)
  ) {
    return reject('binding_incomplete');
  }

  // 6. stale — the bundle's bound materialHash must equal the current tree's.
  if (binding.materialHash !== context.currentMaterialHash) {
    return reject('stale');
  }

  // 7. digest_mismatch — every present receipt must carry a well-formed
  //    sha256 hex outputDigest (no empty/malformed identities).
  for (const receipt of bundle.receipts) {
    if (!nonEmptyString(receipt.outputDigest) || !HEX_SHA256.test(receipt.outputDigest)) {
      return reject('digest_mismatch');
    }
  }

  // 8. receipt_not_passing — each receipt must be a genuine PASS: a non-empty
  //    command, an integer exitCode === 0, and a valid sha256 hex outputDigest.
  //    Mirrors DONE validation treating a nonzero receipt exit code as blocking
  //    (F-008) — a 'pass' bundle whose receipt exited 1/-1 must NOT be accepted.
  for (const receipt of bundle.receipts) {
    if (
      !nonEmptyString(receipt.command)
      || !isInteger(receipt.exitCode)
      || receipt.exitCode !== 0
      || !nonEmptyString(receipt.outputDigest)
      || !HEX_SHA256.test(receipt.outputDigest)
    ) {
      return reject('receipt_not_passing');
    }
  }

  // 9. build_proof_missing — there must be at least one receipt (the build/
  //    test proof). An empty receipts array is an unprovable claim.
  if (bundle.receipts.length === 0) {
    return reject('build_proof_missing');
  }

  // 10. decision_not_pass — only a 'pass' decision is acceptable.
  if (bundle.decision !== 'pass') {
    return reject('decision_not_pass');
  }

  return { accepted: true, reason: 'ok', assurance };
}
