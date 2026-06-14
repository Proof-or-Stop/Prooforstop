# B-acec Execution Plan

## Execution Boundary

Allowed work:
- Implement local CLI commands `decision_doc_proposal`, `decision_doc_preview`, and `decision_doc_save`.
- Store proposal metadata in the current story artifact area.
- Save decision docs only under `docs/requirements/decisions/*.md`.
- Register command schemas, aliases, command policy, phase availability, and process fact contract entries.
- Add focused smoke/regression coverage and update the B-16eb execution doc only to match shipped behavior.

Explicitly out of scope:
- Authority Server receipts, `receiptVerified`, `authorityDone`, `fullAuthorityDone`, `productionDone`, `customerKeyRef`, or Layer4 semantics.
- Configurable decision-doc paths outside `docs/requirements/decisions/*.md`.
- Automatic promotion of every `decision_set`.
- INIT reviewer scope expansion or decision-doc writes.
- Any bypass or replacement of the existing decision-doc quorum DONE gate.

STOP conditions:
- Stop before touching files outside checklist file declarations.
- Stop before adding custom path configuration, Authority behavior, or production completion semantics.
- Stop if `decision_doc_save` cannot check target scope without weakening the existing scope contract or lifecycle gates.
- Stop if implementation requires direct edits to `docs/story/**` or `packages/main/tests/fixtures/**`.
- Stop if process fact registry and `scripts/verify-process-fact-contract.mjs` cannot be kept in sync.

## CHK-001

Add a dedicated decision-doc promotion handler plus StoryStore/types helpers for proposal metadata. Implement validation, proposal id allocation, canonical target path derivation, stable digesting, and deterministic Markdown rendering. Preview must call the same renderer as save.

Verification:
- Focused smoke test creates a proposal and previews Markdown.
- Invalid slug, missing fields, missing verificationRequirements, and bad alternatives fail before metadata is accepted.
- Preview leaves git/story metadata unchanged.

## CHK-002

Implement `decision_doc_save` as the only command that writes the project decision doc target. Require `confirm:true`, explicit `mode`, fresh source/proposal digests, canonical target path, and target scope coverage through PLAN file declarations/scope contract or accepted scope extension.

Verification:
- Happy path writes exactly one canonical decision doc in a temp project.
- Existing/missing target mode mismatch fails.
- Stale source decision/proposal digest and out-of-scope target fail closed.

## CHK-003

Wire command schema, registry, aliases, phase availability, command ownership policy, process fact levels, process fact registry, and the verification script. Keep preview read-only; keep proposal/save as local workflow facts; keep non-Authority wording explicit.

Verification:
- `lattice help` lists the commands.
- `scripts/verify-process-fact-contract.mjs` passes and asserts the new commands.
- Command policy tests/smoke coverage confirm ownership and allowed phase behavior.

## CHK-004

Add `decision-doc-promotion-smoke.ts` and package script coverage. Prefer temp project tests that invoke the built CLI so user-visible behavior and file writes are exercised end to end.

Verification:
- `npm --prefix packages/main run build` passes.
- `npm --prefix packages/main run test:decision-doc-promotion-smoke` passes.
- Existing process fact contract script passes.

## CHK-005

Update documentation only if implementation reveals precise first-version behavior that the B-16eb plan did not already specify. Keep NAV aligned if touched.

Verification:
- Documentation grep confirms no Authority/custom-path/productionDone overclaim.
- If docs are unchanged, checklist evidence records why no documentation update was required.

## Commit And Phase Plan

1. Complete PLAN review and scope check.
2. Enter DEV and initialize scope contract from PLAN.
3. Implement handler/core behavior first, then CLI/policy registration.
4. Add smoke tests and process fact script assertions.
5. Build and run focused tests before marking items done.
6. Enter REVIEW only with clean git status and fresh scope contract.
7. Run REVIEW lanes, TEST validation, delivery check, and DONE gates.
