## CHK-001 — Define versioned impact classification and fail-closed eligibility

Add a single registered ImpactClassificationPolicy and a stable freshness classification at the canonical freshness reader. Resolve only a latest integrity-verified same-lane prior PASS with its valid ReviewRun and Prompt Envelope as an incremental baseline. V1 permits metadata-only/no-material change and pure fixture deltas whose paths and Story-scoped intentRefs are complete; every other category selects full with stable reason codes. Keep the existing handler read-only.

Verification: exercise trusted bounded cases, forced-full classes, unknown and unavailable facts, wrong-lane or tampered baselines, empty storyFilesHash, caller override attempts, and registry-version drift.

## CHK-002 — Assemble bounded reviewBasis and choose the safe context mode

Build reviewBasis from current authoritative claims, invariants, unresolved and changed findings, affected verification intents, affected contracts, changed and impacted files, scope acknowledgement, and repository-relative read-through references. Decide safety first. Only after full and incremental artifacts are assembled may cost select full with FULL_CHEAPER_OR_EQUAL. Budget violations never downgrade correctness-required full context.

Verification: prove exact delta identities, authoritative reference handling, omission fail-closed behavior, reviewer full escalation, final-size comparison, and immunity to caller size or estimator manipulation.

## CHK-003 — Bind incremental envelopes to ReviewRun and pass gates

Extend PromptEnvelope validation and trusted review_run_start assembly for conditional incremental fields. Generalize the existing ReviewRun envelope verifier rather than creating a second gate. Recompute the same eligibility and reviewBasis bindings at write-time and through collectReviewerEvidenceState so REVIEW, readiness, preflight, status, and quorum share one admissibility result. Preserve legacy-full-context behavior without allowing legacy evidence to establish a new incremental baseline.

Verification: accept exact valid incremental bytes and reject missing, stale, mismatched, wrongly served, or single-field-tampered envelopes at pass write and downstream collection boundaries.

## CHK-004 — Prove read-only compatibility, escalation safety, and budget behavior

Retain the existing before-and-after store and gate snapshot smoke and extend it across deterministic and concurrent advisory calls. Prove reviewer read-through and reasoned full escalation. Report incremental/full sizes and budget state independently from correctness eligibility. Update process-fact registry verification and the canonical decision record with the implemented v1 support boundary.

Verification: run focused impact, envelope, ReviewRun, quorum, process-fact, build, full test, and lattice validate suites; record command-backed evidence for every verificationIntent and milestone.
