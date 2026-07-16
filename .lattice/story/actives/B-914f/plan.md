# B-914f Execution Plan

## CHK-001
Extract the exact-head and trusted story-metadata-descendant classifier from DONE reuse into a shared pure helper. Define a versioned RoutineValidationIdentity covering the resolved validation source, normalized command envelopes, entrypoint content digests, full/focus/profile mode, and verification policy inputs. Extend TestEvidenceData so only new PASS evidence with a complete identity can be reused; missing or malformed legacy fields produce an execute fallback.

Verification: table-driven identity equality and one-field drift cases; exact-head, trusted metadata descendant, untrusted descendant and non-ancestor lineage cases; build and process-fact contract.

Rollback: remove the optional identity field and shared call sites; validation continues executing exactly as before.

## CHK-002
Add the reuse decision inside withValidationExecutionLock before each execution branch. Require prior PASS, zero missing required coverage, clean tree, matching materialHash/storyFilesHash and identity, accepted lineage, and unchanged HEAD after the decision. Apply consistently to configured commands, fallback discovery and validate-file flows. Any exception or mismatch returns an executed disposition and runs the normal plan.

Verification: zero-command counters for exact and metadata-descendant reuse; real execution counters for dirty tree, mismatch, incomplete coverage, previous FAIL, malformed evidence, untrusted lineage and TOCTOU.

Rollback: disable/remove the pre-execution branch; normal validation execution remains intact.

## CHK-003
Return a structured executed-versus-reused disposition and precise refusal reasons. On reuse, decorate the existing PASS for the current request without calling writeTestEvidence or autoCommitStoryMetadata, preserving artifact bytes and HEAD. On execution, persist the new identity with the ordinary evidence write. Register any gate-consumed runtime semantic in the process-fact registry and verifier.

Verification: assert reused output names the basis and lineage, prior evidence file digest/mtime and HEAD remain unchanged, and each mismatch has a stable refusal reason while still executing.

Rollback: disposition can remain diagnostic while reuse is disabled; no evidence migration is destructive.

## CHK-004
Add an end-to-end regression matching B-19ca: first validation executes and all commands PASS; verificationEvidence metadata is refreshed without product material or validation identity changes; the next validation returns PASS with zero command executions. Cover configured, fallback and validate-file sources plus focus/full/profile/policy and entrypoint drift. Update the workflow decision document with the final identity and reuse contract.

Verification: dedicated smoke, TypeScript build, process-fact contract, routine configured validation, DONE-required suite, and real-machine transcript showing the second invocation is reused.

Rollback: the smoke fails if reuse is removed or becomes permissive, making rollback explicit and observable.
