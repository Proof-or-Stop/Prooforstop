# B-fd64 Execution Plan — Authority usage-evidence (local slice, Touchpoint 6)

Local, server-independent part only. All in the usage-ledger module; the verifier is
PLUGGABLE (injected) so the module keeps zero cross-module imports (no authority-signing
import). The anti-overclaim gate is the point: local records stay receiptVerified=false.

## Approach
- `core/usage-ledger/authority-evidence.ts` (pure; ./ siblings + node only):
  - `buildUsageEvidenceEnvelope(record)` -> privacy-preserving envelope: a recordDigest
    (sha256 of the canonical record via canonical-json.ts) + an allowlist of non-secret
    fields (model, provider.name, usage counts, source, correlation ids, decision). NO raw
    prompt/transcript/secret/key/auth-header (reuse the privacy denylist; reject/omit).
  - `verifyUsageReceipt(envelope, signedReceipt, verify)` -> verify is an INJECTED fn
    (signedReceipt, envelope) -> {verified, subjectKind?, subjectId?}. Returns an authority
    block with receiptVerified=true + receiptId + receiptSubject* ONLY when verify.verified
    AND subject binding matches the envelope; else receiptVerified=false.
- `core/usage-ledger/record.ts`: ensure the authority block allows nullable receiptId +
  receiptSubjectKind + receiptSubjectId; keep the validator rejecting local receiptVerified!=false
  except via the gate; a referenced receipt without verification stays false.

## Checklist order
CHK-001 envelope -> CHK-002 record fields -> CHK-003 gate -> CHK-004 negative controls ->
CHK-005 smoke + no regression.

## Verification
`tasks/usage-ledger-authority-smoke.ts` (npm test:usage-ledger-authority): envelope is
privacy-safe + has a digest; record validates with nullable receipt-ref fields; the gate
verifies ONLY via injected verifier + subject match (false/mismatch/no-verifier stay false);
4 negative controls (transport accepted, provider tokens, local hash, copied receiptId) each
keep receiptVerified=false; usage-ledger zero-cross-module-import assert. Build clean; full
ledger suite (usage-ledger/-adapter/-estimate/-diagnostics/-dispatch/-budget) no regression;
node bin/lattice.js validate.

## Out of scope
A live authority server; network submission; real signature cryptography (verifier injected);
marking local records verified without an injected verifier.
