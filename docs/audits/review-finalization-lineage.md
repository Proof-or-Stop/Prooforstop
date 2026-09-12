# Managed review after inventory finalization

B-0980 exposed a protocol mismatch: the inventory finalizer batches signed
review artifacts into a canonical epoch commit, while managed review consumption
accepted only individual importer commits. Refreshing authentic verification
receipts introduced another official metadata commit that readers rejected.
The inventory critic consumer also eagerly rebuilt an OPEN-only provider prompt
after its epoch had already finalized.

Review and certification now share a narrow maintenance-commit classifier.
Epoch publication requires its exact canonical paths, signed finalized epoch and
receipt, original cutoff and a live non-revoked terminal epoch. Reusing a finalized
epoch under another writer-like commit subject is refused. Passing evidence refreshes
must preserve the entire checklist except verification evidence, retain prior
intent coverage and authenticate every replacement through the strict V5 receipt
verifier. Tracked causal receipt/index projections are verified against their signed, content-addressed records; the index remains append-only. Owner-lease bookkeeping is not review or ownership-transfer authority. This classifier retains lineage only; ordinary scope, material,
review, intent freshness and certification gates still decide authority.

Managed critic consumption checks the current signed inventory subject and uses
the launch digest already authenticated by the immutable managed execution seal.
It does not relaunch the reviewer or reconstruct a changed prompt. Launch still
requires OPEN; cancelled, invalidated, tampered and mismatched subjects fail closed.

Run `npm run test:review-epoch-certification-continuity` after building. Disposable
fixtures exercise actual reviewer and finalization handlers, managed lineage,
authenticated evidence refresh, forged publishers, wrong paths, cancellation and
certification admission. Native fixture identities and local Lab records are test
provenance; they are not independent vendor audits or formal Story completion.
