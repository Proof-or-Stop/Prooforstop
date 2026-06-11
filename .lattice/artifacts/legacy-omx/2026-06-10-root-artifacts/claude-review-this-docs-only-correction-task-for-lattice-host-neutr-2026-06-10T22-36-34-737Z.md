# claude advisor artifact

- Provider: claude
- Exit code: 0
- Created at: 2026-06-10T22:36:34.738Z

## Original task

Review this docs-only correction task for Lattice host-neutral correctness. Current facts: staging exposes GET /v1/receipts/{receipt_id}/proof, OpenAPI has AuthorityReceiptProof, AuthorityReceipt has subjectKind/subjectId/subjectDigest/authorityActorId, GateDecision exposes decisionId/storyId/repo/stateVersion/evidenceDigests/producerRunIds/verifierRunIds/runnerSessionIds, productionEnforceAuthority=true and server key is configured/non-ephemeral/non-productionInert. Orchestrate docs still say server only returns receipt envelope, Wave 1 still says add proof endpoint/schema, receipt subject fields are Missing/Decision needed, and CLI doc only says fetch associated payloads. Principles: do not optimize for optimization sake, do not optimize arbitrarily, only fix real correctness issues, consistency of logic, host-neutral Lattice semantics. Is the proposed small docs sync correct? Output concise actionable findings only.

## Final prompt

Review this docs-only correction task for Lattice host-neutral correctness. Current facts: staging exposes GET /v1/receipts/{receipt_id}/proof, OpenAPI has AuthorityReceiptProof, AuthorityReceipt has subjectKind/subjectId/subjectDigest/authorityActorId, GateDecision exposes decisionId/storyId/repo/stateVersion/evidenceDigests/producerRunIds/verifierRunIds/runnerSessionIds, productionEnforceAuthority=true and server key is configured/non-ephemeral/non-productionInert. Orchestrate docs still say server only returns receipt envelope, Wave 1 still says add proof endpoint/schema, receipt subject fields are Missing/Decision needed, and CLI doc only says fetch associated payloads. Principles: do not optimize for optimization sake, do not optimize arbitrarily, only fix real correctness issues, consistency of logic, host-neutral Lattice semantics. Is the proposed small docs sync correct? Output concise actionable findings only.

## Raw output

```text
Here are concise findings against the four stated gaps:

---

**Finding 1 — CORRECTNESS: execution-plan.md gap §1 is stale**
`authority-receipt-gate-integration-execution-plan.md:58-60` says the server "contains only the receipt envelope" and CLI "cannot recompute inputDigest or decisionDigest without the associated input/decision payloads." Staging has `GET /v1/receipts/{receipt_id}/proof` returning `AuthorityReceiptProof` with both payloads. This gap is closed. **Fix: update gap §1 status to resolved, citing the proof endpoint.**

**Finding 2 — CORRECTNESS: Wave 1 reads as future work for shipped code**
`authority-receipt-gate-integration-execution-plan.md:88-115` — "Implement: Add a response schema such as `AuthorityReceiptProof`" and "Add `GET /v1/receipts/{receiptId}/proof`" are imperative TODOs for work that exists in staging. A future reader or agent would attempt to re-implement it. **Fix: mark Wave 1 items 1-2 as done with the actual schema/route names.**

**Finding 3 — CORRECTNESS: receipt contract capability baseline is factually wrong**
`lattice-authority-receipt-contract.md:29` — "Receipt subject fields | Missing/Decision needed" when `AuthorityReceipt` already has `subjectKind`, `subjectId`, `subjectDigest`, `authorityActorId`. **Fix: update status to Done and record the actual field names that landed.**

**Finding 4 — MINOR: CLI doc verification step 1 is imprecise but not wrong**
`lattice-cli-authority-client-receipt-ref.md:93` says "Fetch receipt and associated input/decision payloads." This describes the CLI's action, not the server route. Now that the proof endpoint exists, saying "Fetch receipt proof bundle via `GET /v1/receipts/{receiptId}/proof`" is more precise and avoids the implication that the CLI must make multiple fetches. **Fix: update step 1 to name the proof endpoint. Low priority — the current text isn't incorrect, just vague.**

---

**Verdict: the proposed docs sync is correct.** All four gaps are real factual inaccuracies (not optimization). Findings 1-3 are genuine correctness/staleness issues that would mislead implementation. Finding 4 is minor but still a legitimate precision fix. No host-specific leakage concerns — all changes stay within host-neutral Lattice semantics (server endpoint, schema names, field names). No scope creep detected.

```

## Concise summary

Provider completed successfully. Review the raw output for details.

## Action items

- Review the response and extract decisions you want to apply.
- Capture follow-up implementation tasks if needed.
