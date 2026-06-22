# Plan — B-7b6e: gate-strength self-red-team harness (capability slice 2)

## Approach
Promote the §6 'passes-the-visible-test-but-wrong' idea into a first-class, hermetic, reviewer-agnostic harness that measures a gate's discrimination and publishes it as a B-4c65-verifiable receipt.

## CHK-001 — core/gate-strength.ts
- `Probe` type: { id, artifact, visibleAcceptancePass:true, groundTruthPass:boolean, defectKind:'overfit'|'subtle'|'buried'|'none' }; a STANDING_CORPUS of probes (overfit lookup-table, subtle falsy-guard, buried-needle — all pass the visible test; genuine-solution control passes ground-truth too).
- `Reviewer = (probe) => { ship: boolean, reason: string }` interface; `testOnlyReviewer` (ships iff visibleAcceptancePass → catches 0 wrong ones); `specAwareReviewer` (ships iff groundTruthPass, with a per-probe reason → catches all wrong ones, ships genuine).
- `runGateStrength(reviewer, corpus)`: for each probe compare reviewer.ship vs the hidden groundTruthPass; classify caught / shipped-wrong / blocked-genuine; return { total, wrongTotal, caught, falseShip, falseBlock, catchRate, perProbe[] }.
- `gateStrengthBundle(result, privateKey)`: build a B-4c65 ReceiptBundle whose receipts encode the per-probe outcomes + the catch-rate, signed local-key; verifiable via verifyReceiptBundleOffline (assurance=local-key-single-host).

## CHK-002 — tasks/gate-strength-contract-smoke.ts (hermetic)
- Assert testOnlyReviewer → catchRate 0 (catches 0/N wrong, falseShip = all wrong) — proves the visible-test gap.
- Assert specAwareReviewer → catchRate 1.0 (catches N/N wrong with the correct per-probe reason, ships the genuine one) — proves discrimination is real, not a block-everything constant.
- Assert the two endpoints DIFFER (0 vs 1.0) so the metric is non-vacuous.
- Build the gate-strength receipt from the spec-aware run and assert verifyReceiptBundleOffline(bundle, {currentMaterialHash: bundle.binding.materialHash, publicKey}) → accepted.
- Visible pass line; hermetic (no network/dispatch). Register in lattice.config.json; CHANGELOG entry (honest hermetic/reference-reviewer scope, live review-lane deferred).

## Rollback
Pure additive (new core module + new smoke + 1 config line + CHANGELOG). Rollback = revert the commit; nothing depends on it, no gate/DONE change.

## Out of scope (deferred)
Live claude -p review-lane dispatch as a reviewer; continuous/scheduled running. Both plug into the reviewer-agnostic interface later.

## Verification
The CHK-002 contract smoke IS the verification: 0-vs-all bracketing proves the metric discriminates, the receipt verifies offline. tsc green.
