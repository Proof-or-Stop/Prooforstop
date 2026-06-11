# B-2522 Plan

## Goal
Finish milestones 7-8 for Koala/Lattice authority enforce: a verified Python AuthorityReceipt can promote a fully bound verifier envelope to receipt-backed L2+, while ordinary local/off, shadow, and parallel planning paths remain non-authoritative and usable without a server.

## CHK-001: Build signed full L2 evidence envelope and verify authority receipt metadata

**Owner**: claude-code-implementer

**Dependency**: None. This item owns a pure local receipt classification smoke and does not depend on CHK-002 broad matrix.

**Implementation**:
1. Add a small pure helper, tentatively packages/main/src/core/authority-receipt-classification.ts, that accepts an EvidenceEnvelopeContract, an AuthorityReceipt, the authority public key, and transport metadata.
2. Verify the receipt signature using verifyAuthorityReceipt and verify receipt subject binding to the envelope, at minimum subjectKind=evidence, subjectId=envelope.evidenceId, and subjectDigest matching the signature-less envelope digest when present.
3. Feed receiptVerified=true into classifyAuthorityEvidence only after signature and subject binding pass.
4. Keep classifyCliAuthoritySubmission unchanged for ordinary workflow submissions: it must continue to use receiptVerified=false.
5. Add packages/main/src/tasks/authority-receipt-classification-smoke.ts and package scripts for it.

**Verify**:
- npm --prefix packages/main run build
- npm run test:authority-receipt-classification
- npm run test:authority-boundary-smoke
- npm run test:authority-runner-contracts
- npm run test:authority-evidence-flow

**Done when user sees**:
- authority receipt classification smoke passed: receiptVerified=true klass=receipt-backed-l2-plus only after signed receipt verification
- Same-run producer/verifier, missing commandDigest / transcriptHash / diffHash, bad receipt signature, wrong receipt subject, and accepted:true without verified receipt all remain non-receipt-backed.

## CHK-002: Add local/off versus enforce E2E tests, docs, and Lattice parallel report evidence

**Owner**: claude-code-implementer

**Dependency**: CHK-001 helper and script should exist first so the fake-server matrix can reuse the same receipt verification semantics.

**Implementation**:
1. Add packages/main/src/tasks/authority-enforce-matrix-smoke.ts that exercises the end-to-end matrix with deterministic local fakes: local/off PASS, shadow warning PASS, enforce fake-server receipt PASS, enforce no-server runner fail-closed PASS, and parallel_report non-authoritative PASS.
2. Add packages/main/src/tasks/authority-live-python-smoke.ts as a gated live check. It must print a clear skip line and exit 0 unless explicit live authority env vars are present.
3. Update root and package scripts for both new tasks.
4. Update README.md, docs/guide.md, docs/requirements/decisions/authority-client-role.md, and if needed docs/requirements/decisions/lattice-parallel-wave.md so the current state is no longer described as future only where CHK-001/CHK-002 have landed.
5. Keep parallel wave/report docs explicit: scheduling artifacts stay read-only, non-authoritative, and cannot satisfy DONE.

**Verify**:
- npm --prefix packages/main run build
- npm run test:authority-enforce-matrix
- npm run test:authority-live-python
- npm run test:authority-status-smoke
- npm run test:authority-enforce-runner
- npm run test:authority-runner-events
- npm --prefix packages/main run test:lattice-parallel-wave-smoke
- lattice validate --story=B-2522 --json

**Done when user sees**:
- authority enforce matrix smoke passed: local/off PASS; shadow warning PASS; enforce fake-server receipt PASS; enforce no-server runner fail-closed PASS; parallel_report productionDone=false PASS
- authority live Python smoke skipped: set KOALA_AUTHORITY_LIVE_URL and KOALA_AUTHORITY_LIVE_PUBLIC_KEY to run

## Scope Notes
- This story does not implement a real long-running provider runner loop, actor-key persistence, or Mac runner behavior.
- It does not require a paid Python authority server for local usage.
- It must not alter unrelated story lifecycle gates, general review lanes, or non-authority commands.
