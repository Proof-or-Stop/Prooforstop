## Trigger Event
M0 (story B-9e44) reached DONE and merged to main on 2026-07-05 (merge 056a39107), freezing protocol.json (sha256 a3a781fed2814259...). M1 is milestone 2 of plan section 8 (strict order M0 to M4).

## Key Insights
The frozen protocol.json.tamperMatrix has failClosed(18), acceptanceBucket(2), acknowledgedLimitations(6), dropped(1) — each entry carries its expected fingerprint over the explicit domain (boolean flag vector + numeric-metric predicates). M0 already proved (via viability-check.mjs) that each class produces its disposition; M1 RE-RUNS each class through a committed campaign harness (tamper.mjs) and ASSERTS the live verdict MATCHES the frozen fingerprint, emitting tamper-verdicts.jsonl as the H2 evidence artifact. The distinction from M0: M0 discovered+froze the fingerprints; M1 is the reproducible campaign that verifies conformance against the freeze and produces the per-class verdict ledger. lib/instrument.mjs (verifyDir with a {status:'crash'} sentinel for structural corruption, refreshManifest, fingerprintDomain, canonicalJson) is reused as-is. Because the verifier has no textual reason, the fingerprint-match boolean is the mechanical H2 adjudication.

## Solution Tradeoffs
tamper.mjs reads protocol.json (the frozen contract) rather than re-deriving mutations, so a drift between the harness and the freeze is caught as a fingerprint mismatch. Each mutation is applied to an mkdtemp isolated copy (never the source). tamper-verdicts.jsonl is identity-keyed (tamper/<scale>/<class>/<manifestHandling>) and canonical for reproducibility. Rejected alternative: recomputing fingerprints inside tamper.mjs (would make the freeze meaningless — the whole point is conformance TO the M0 freeze).

## Conversational Texture
The operator directed on 2026-07-05 to execute the plan milestones in strict order until all DONE. M0 is done; this is M1. M1 delivers only the tamper matrix harness + verdict ledger + selfcheck; the replay driver is M2, resume probe M3, analyzer M4.
