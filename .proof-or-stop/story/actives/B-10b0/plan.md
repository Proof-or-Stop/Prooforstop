# B-10b0 Execution Plan

## Outcome

A normal closeout keeps valid code-review receipts when only registered nonmaterial closeout metadata changes, while every closeout artifact remains independently fail-closed. The REVIEW to TEST to DONE path converges without metadata-only rollback, extra reviewer re-attestation, human confirmation, or unchanged-suite execution.

## CHK-001

Introduce a shared classification boundary that reports review retention separately from artifact admissibility. Review retention requires unchanged materialHash, storyFilesHash, scope, policy, command set, and review round, plus an intervening diff containing only registered nonmaterial closeout metadata. Scope-defining metadata, unknown paths or writers, malformed lineage, manual tampering, and all real drift invalidate retention. Existing artifact consumers continue to validate their own structure, signatures, writer provenance, and freshness; a retained review receipt can never authorize a closeout artifact.

Add focused positive coverage for canonical closeout writers and negative coverage for source, story-owned, config, policy, command-set, scope, round, unknown-writer, tamper, malformed, and unsigned cases. Update process-fact registry and contract verification for any gate-consumed semantic introduced.

## CHK-002

Align delivery reviewer dispatch phases with delivery-check mutation phases and order closeout writes so REVIEW to TEST to DONE does not invalidate a valid review of unchanged material. Prevent the transition-time routine validation write and later DONE-required, summary, transcript, and delivery writes from causing metadata-only return to DEV or REVIEW.

Add a deterministic lifecycle regression whose machine-readable counters prove: zero metadata-only phase rollbacks, zero extra reviewer re-attestations, zero human confirmations, zero executions of an unchanged validation command set, and one successful closeout. Preserve fail-closed behavior when any covered identity or artifact gate changes.

## CHK-003

Replace line-oriented deleted-symbol extraction with declaration-aware comparison so function or method body edits are not treated as deletions. Preserve detection for true declaration removal and residual references. Cover body-only edits, signature edits, overloads, methods, constructors, rename, true deletion, and residual-reference cases.

## Verification and scope

Use only focused lifecycle, closeout-trust, review-run, delivery-dispatch, concept-gate, and process-fact contract checks during DEV. No real hosts, network, global lattice, root full suite, destructive git commands, or user-owned main artifacts. Full configured validation remains a TEST or DONE concern and must reuse a fresh PASS when identity is unchanged.
