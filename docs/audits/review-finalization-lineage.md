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

Official certification admission additionally preserves only the exact finalized
inventory consumption delta bound to its admitted window. Routine validation
requires append-only closeout receipts bound to the changed artifact bytes and
parent commit. TEST publication must satisfy the existing exact REVIEW-to-TEST
index transition validator. These checks retain code review; they do not grant
certification or validation PASS authority.

Managed critic consumption checks the current signed inventory subject and uses
the launch digest already authenticated by the immutable managed execution seal.
It does not relaunch the reviewer or reconstruct a changed prompt. Launch still
requires OPEN; cancelled, invalidated, tampered and mismatched subjects fail closed.

Run `npm run test:review-epoch-certification-continuity` after building. Disposable
fixtures exercise actual reviewer and finalization handlers, managed lineage,
authenticated evidence refresh, forged publishers, wrong paths, cancellation and
certification admission, routine validation and actual TEST publication. Native fixture identities and local Lab records are test
provenance; they are not independent vendor audits or formal Story completion.

## Independent audit repair follow-up

Claude invocation 2e094f2f-a8f9-49e0-af33-9b345128c7a3 rejected prepared candidate d8ae4ede1ffcb3b5bb21e83e627c2a476a704801. Its findings are retained in the local Lab audit record. The repair removes the missing managed-prompt seal fallback; missing/malformed seals fail closed. Finalized critic consumption requires the terminal wave and the epoch Story identity. Epoch publication preserves prior review collection prefixes. Causal output files are checked against the SHA-256 of the exact output string (the existing store address contract, not the JSON wrapper), with a valid same-tree receipt reference. Incidental protocol paths are refused if closeout policy classifies them as gate artifacts. The TEST comparison derives its round from the original immutable reviewed commit, rather than the proposed transition. Its negative controls independently corrupt stable fields, event count, event keys and round while starting from REVIEW.

Managed fixture capacity and completion have separate bounded deadlines. Nonterminal timeout cancels the actual run and reports a distinct completion timeout. Capacity refusal is already terminal and creates no provider; it is retained, never skipped, and each retry obtains a fresh dispatch and ReviewRun. This synthetic runner does not invoke a production model. The broader smoke failure is reported as an unresolved baseline observation, not evidence that this fixture's transport is broken. The notes provide bounded unchanged dependency excerpts for independent context. No production admission or deadline is relaxed.
