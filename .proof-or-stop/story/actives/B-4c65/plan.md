# Plan — B-4c65: offline portable receipt verifier + adversarial contract test

## Approach
Slice 1 of the tamper-evident verifiable-autonomy capability. Build a self-contained,
local-key-signed receipt bundle from a DONE story's LOCAL gate evidence, plus an OFFLINE verifier
that re-checks the binding without any Authority server, then prove soundness with an adversarial
tamper-class contract test (which doubles as the paper's C2 data proof).

## CHK-001 — core/receipt-bundle.ts (bundle + offline verify)
- `buildReceiptBundle(storyEvidence, signKey)`: gather materialHash/headHash/storyFilesHash +
  policyHash/commandSetHash + per-command exit code + output digest (from test-evidence.json and
  done-required-evidence.json) + host verdicts; produce a canonical, self-contained bundle and
  sign it with a local ed25519 key (signCanonical / signLatticeAuthorityEnvelope).
- `verifyReceiptBundleOffline(bundle, { currentMaterialHash, currentStoryFilesHash, publicKey })`:
  re-check (1) all binding fields present; (2) bundle.materialHash === currentMaterialHash
  (freshness conjunct); (3) the local-key signature verifies over the canonical bundle
  (anti-forgery); (4) the recorded receipt-identity / output digests re-derive consistently;
  (5) decision/exit = pass. Return `{ accepted, reason, assurance: 'local-key-single-host' }`.
  NO network/server. Reuse digest helpers from authority-gate-receipt-verifier.ts.
- Honest labeling: result + bundle mark `assurance='local-key-single-host'` — explicitly NOT the
  Authority Tier-C strong proof.

## CHK-002 — tasks/receipt-bundle-contract-smoke.ts (adversarial contract test)
- Build an authentic fixture bundle; assert verifyReceiptBundleOffline → ACCEPTED (control vs a
  block-everything verifier; guards against a vacuous pass).
- For each tamper class — code byte-flip (changes the tree's materialHash), evidence JSON edit,
  host-verdict swap, commandSet change, stale materialHash (mismatched currentMaterialHash),
  forged signature (re-sign with a wrong key), missing signature, missing build-proof — mutate the
  authentic bundle and assert verifyReceiptBundleOffline → REJECTED with the correct reason code.
- Lying-agent: a done/pass claim whose evidence is stale OR forged → REJECTED naming the reason.
- Assert 0 false-accept (no tamper accepted) AND 0 false-reject (authentic accepted). Print the
  matrix + a visible pass line.
- Register in lattice.config.json; hermetic (no network, no server).

## Rollback path
Pure additive: a new core module + a new smoke + one config line + a CHANGELOG entry. Rollback =
revert the commit; nothing else depends on the new module, and no gate/DONE behavior changes.

## Out of scope (deferred)
Authority cross-host signed verdicts / server signing (Tier-C follow-up); a user-facing CLI verb
(follow-up slice). This slice ships single-host + local-key only, honestly labeled.

## Verification
The CHK-002 contract-test matrix IS the verification (and the paper's C2 data proof): every tamper
class rejected, authentic accepted, 0 false-accept / 0 false-reject. tsc must stay green.
