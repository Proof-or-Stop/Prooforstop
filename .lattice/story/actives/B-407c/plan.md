"# Story 6 execution plan

## CHK-001
- Inspect frozen Story 1 registry and Story 2 trusted full-context assembly.
- Migrate story-init, scope-plan, implementer, delivery, and evaluator assets to existing modular Prompt Envelope producer path.
- Preserve role/status semantics, Task Context schema, permission checks, and signed run bindings.

## CHK-002
- Apply complex-role prompt budgets from the decision document.
- Implement observe/warn: record structured budget violation and reason when over budget while retaining full correctness review.
- Verify under-budget and over-budget paths and prove warning cannot become a blocking gate.

## CHK-003
- Run one real dispatch A/B comparison for each migrated role against the legacy/full path.
- Record prompt path, output, provider usage/cache/latency where available, and explicit INCONCLUSIVE values for unavailable provider dimensions.
- Reject duplicate, forged, or role-mismatched receipts.

## CHK-004
- Verify delivery promises, scope-gap classification, implementer author, evaluator evidence, permission-gated mutations, signed runs, and Task Context digest binding.
- Exercise happy, missing-evidence, invalid-signature, unauthorized-mutation, and wrong-context cases.
- Record evidence for each checklist intent and delivery/review artifacts needed for TEST and DONE.

## Out of scope
- Story 7 budget enforce promotion and any enforce gate.
- Changes to Task Context schema or role status definitions.
- Rewriting Story 1/2/5 shared Prompt Envelope, review, or closeout contracts beyond integration fixes required by this migration."
