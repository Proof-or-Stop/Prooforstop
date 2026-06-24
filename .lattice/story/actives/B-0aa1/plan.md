# B-0aa1 Execution Plan

## Goal

Implement the Repro-first candidate-only evidence intake MVP. The user should be able to capture a red repro, review it, record/review a spike, evaluate a red-green relation, review a regression matrix, and create a formal story from the candidate without treating candidate evidence as DONE or production proof.

## Non-Goals

- No Authority Server quorum implementation.
- No full Proof Admissibility enforce mode.
- No production DONE gate consumption of candidate artifacts.
- No UI/dashboard work.
- No legacy evidence migration.

## CHK-001

Add a minimal shared evidence artifact store under `packages/main/src/core/evidence/`.

Steps:
- Define an immutable artifact envelope with `artifactId`, `artifactKind`, `evidenceScope`, `schemaVersion`, timestamps, producer, payload, and sha256 digest.
- Store canonical JSON objects under `.lattice/evidence/objects/sha256/<digest>.json`.
- Store refs under `.lattice/evidence/refs/by-id/<artifactId>.json` and candidate/story indexes where needed.
- Append observed events to `.lattice/evidence/ledger/observed.jsonl`.

Verification:
- Smoke creates candidate artifacts and reloads them by id/digest.
- Smoke asserts candidate artifacts report `evidenceScope=candidate-only` and are not production/DONE admissible.

## CHK-002

Implement `ReproIntakeService` as the business layer for candidate intake.

Steps:
- Implement `createProbe`, `reviewProbe`, `recordSpike`, `reviewSpike`, `createRedGreenRelation`, `evaluateRedGreenRelation`, `reviewRegressionMatrix`, `createStoryFromRepro`, and `getStage`.
- Keep all repro/spike/relation/matrix records candidate scoped.
- Make red-green relation evaluation fail closed on missing reviewed refs, command digest mismatch, or expected failure pattern mismatch.
- Make `createStoryFromRepro` call existing `story_create` logic and then write a story binding artifact.

Verification:
- Smoke covers reviewed red probe, reviewed spike, relation pass/mismatch, regression matrix gap, and story binding.

## CHK-003

Expose thin CLI handlers and command catalog entries.

Steps:
- Add `packages/main/src/handlers/repro-intake.ts` with thin handlers that call `ReproIntakeService`.
- Register handlers in `packages/main/src/registry.ts`.
- Add schemas in `packages/main/src/cli/command-catalog.ts` for `repro_probe`, `repro_probe_get`, `repro_review_set`, `spike_record`, `spike_review_set`, `red_green_relation_create`, `red_green_relation_evaluate`, `regression_matrix_review_set`, and `story_create_from_repro`.
- Return clear JSON-compatible results including artifact ids, digests, candidate stage, and scope.

Verification:
- Smoke drives the new commands through the built CLI.
- Invalid or unreviewed inputs fail with explicit errors.

## CHK-004

Add focused smoke tests for the candidate-only workflow.

Steps:
- Add `packages/main/src/tasks/repro-first-candidate-smoke.ts`.
- Use an isolated temporary root and the built CLI.
- Assert candidate artifacts are immutable and non-production scoped.
- Assert `story_create_from_repro` does not add verificationEvidence to the created story.
- Add a package script for the smoke.

Verification:
- `npm --prefix packages/main run build` passes.
- `node packages/main/dist/tasks/repro-first-candidate-smoke.js` passes.
