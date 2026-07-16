# B-914f Execution Plan

## CHK-001
Extract exact-head and trusted story-metadata-descendant classification into a shared pure helper. Define a versioned routine validation identity over source kind, normalized ordered commands, command/entrypoint digests, full/focus/profile, stable required-intent/workflow policy, effective child-environment digest, platform/arch/Node, material and story-file bindings. Legacy or malformed identity executes.

Verification: equality plus one-field drift matrices; exact, metadata-descendant, untrusted and non-ancestor lineage. Rollback removes the optional identity and restores always-execute behavior.

## CHK-002
Inside withValidationExecutionLock, recompute current coverage and decide reuse before each execution branch. Require stored commandExecution PASS, current missingRequired=0, matching identity/material/story files, clean tree, accepted lineage and stable second HEAD read. Any exception or mismatch executes.

Verification: zero-command exact/metadata reuse and real execution for dirty, mismatch, incomplete current coverage, command FAIL, malformed evidence, untrusted lineage and TOCTOU.

## CHK-003
Return executed-versus-reused disposition and precise refusal reasons. Executed runs persist commandExecution plus identity. Reused runs compose the stored command PASS with freshly recomputed coverage but never write test-evidence or metadata, preserving bytes and HEAD. Register gate-consumed semantics in the process-fact registry.

Verification: reused output basis/lineage, byte-identical evidence, unchanged HEAD/status/commit count, stable refusal diagnostics.

## CHK-004
Build table-driven and end-to-end coverage for configured commands, fallback discovery, validate-file and no-validator behavior. Reproduce B-19ca with an initial 45-command PASS plus overall coverage-only FAIL, trusted verificationEvidence refresh, then PASS reused with zero command executions.

Verification: dedicated smoke, build, process-fact contract, routine and DONE-required suites, and live transcript.

## CHK-005
Extend TestEvidenceData with a structured commandExecution fact independent of the overall coverage-composed result. A prior overall FAIL is reusable only when commandExecution itself is PASS and the prior failure is coverage-only; current coverage is always recomputed and must be complete. Real command failure, infra failure, partial execution or missing receipt never qualifies.

Verification: command PASS + stale coverage -> refresh -> reuse; command FAIL/infra/partial -> execute; forged combinations fail closed.

## CHK-006
Create docs/requirements/decisions/routine-validation-fresh-pass-reuse.md as the canonical subsystem contract for evidence composition, identity fields, environment hashing, lineage, locking, no-write reuse, refusal semantics, migration and rollback. Link the umbrella workflow plan to it without duplicating authority.

Verification: docs reviewer and process-fact contract confirm documentation, types, handler behavior and registry semantics agree.
