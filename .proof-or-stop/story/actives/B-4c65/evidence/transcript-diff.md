# B-4c65 — user-value acceptance (real-machine)

## Expected (PLAN outcome)
A self-contained, local-key-signed receipt bundle + an OFFLINE verifier (no Authority server);
an adversarial contract test where the authentic bundle is ACCEPTED and every tamper class is
REJECTED with 0 false-accept / 0 false-reject — the paper's C2 data proof.

## Actual (this machine)
$ npm --prefix packages/main run build   → clean (tsc)
$ node packages/main/dist/tasks/receipt-bundle-contract-smoke.js
  [ACCEPT] authentic (control)    reason=ok
  [REJECT] 18 tamper classes (every reason code reached): malformed_bundle, stale,
           signature_missing, signature_invalid, signer_key_mismatch, digest_mismatch,
           build_proof_missing, receipt_not_passing, decision_not_pass, binding_incomplete
  lying-agent stale + forged → REJECTED; soundness self-checks (exitCode:1, hostVerdicts.push(null)) → REJECTED
  ✓ ... 0 false-accept, 0 false-reject   (exit 0)

## Diff: expected vs actual
No difference. Independently re-verified: a bundle with a failed receipt (exitCode:1), an empty
command, a null-elided field, or a mismatched signerPublicKey is all REJECTED; an authentic bundle
ACCEPTED. assurance is hardwired 'local-key-single-host' (honestly NOT the Authority Tier-C strong proof).

## Genuine 2-host adversarial cycle (the headline)
Round-1 Codex host-2 (independent vendor) returned VERDICT: FAIL — it caught 4 real soundness holes
(CRITICAL null-elision; check-order; signerPublicKey not bound; receipt exitCode not checked) that
all 4 Claude lanes had passed. Fixed (b7ad42391); round-2 Codex re-verified VERDICT: PASS by
execution. This is a live instance of the paper's own thesis: independent cross-vendor review caught
what same-vendor review missed.

## Acceptance verdict
Accepted. Offline verifier sound (no false-accept / no false-reject), contract test = paper C2 proof,
Authority cross-host signing correctly deferred.
