## Trigger Event
On 2026-06-24, running the maintained `authority-live-receipt-ref-gate` smoke against the real staging Authority (https://staging.hostneutral.net) as a red test, the run FAILED twice in sequence: the DONE gate returned verdict=fail ("requires materialOverlapAudit"), and once that was fixed the gate-receipt proof fetch returned 401 customer_api_key_required. A live, reproducible failure against the production-shaped server, not a hunch.

## Key Insights
The proof endpoint is a PROTECTED Authority read. AuthorityClient.get() only attaches the Authorization header when called with authenticated:true, but fetchGateReceiptProof never set it, and authority-enforce.ts loadProof constructed the client with no auth at all. So ANY authority_receipt_verify --proofPath flow 401s, not just this smoke. Separately the smoke omitted the materialOverlapAudit the DONE enforce gate requires; it is part of the gateInputDigest so it must appear in both the request and the signed decision.

## Solution Tradeoffs
Both layers must change: loadProof must resolve and pass auth, AND fetchGateReceiptProof must request an authenticated read. Either alone is insufficient (no client auth => authenticated read fails closed; no authenticated flag => no header sent). The smoke fix uses buildNoOverlapMaterialOverlapAuditDefault (empty actualFileOverlaps) to match the server's test_done_enforce_gate_passes_with_empty_material_overlap_audit. Alternative rejected: verify the inline receipt instead of the proofPath fetch, because the proofPath fetch is the intended, tested path.

## Conversational Texture
Found via the Red -> Spike -> Story method: the live smoke is the red test (cannot be faked against the real server), a throwaway spike proved the three-part fix end-to-end (green against staging), and only then was this story opened. The verified diff was reverted from the main tree and kept as the DEV reference.
