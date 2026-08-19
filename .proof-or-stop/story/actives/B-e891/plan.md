# B-e891 Execution Plan

## Intent Boundary

Implement only G02 of the UDM no-false-DONE 10x15 baseline. G02 is the missing-row negative control: the required inventory contains 15 G02 rows, the generated ledger contains 14 fresh closed rows, one required row is absent, and full roadmap completion wording must be blocked. G03-G10 remain future work, and this story must not claim full 10x15 completion or elevated rollout assurance.

## CHK-001 Add the G02 missing-row negative-control baseline smoke

**Files**:

- Create `packages/main/src/tasks/parent-roadmap-large-ledger-g02-baseline-smoke.ts`.
- Do not modify `packages/main/src/core/parent-roadmap-totality.ts`.

**Implementation**:

- Mirror the G01 task shape but use `GROUP_ID = "G02"`, story id `B-e891`, and G02-specific ledger ids, row ids, hashes, command text, artifact refs, and claim boundary.
- Build a required inventory of exactly `G02-M01` through `G02-M15`.
- Generate exactly 14 closed rows, intentionally omitting `G02-M15`.
- Evaluate through `evaluateParentRoadmapLedger` and assert: `rowResults.length === 15`, generated rows are 14, closed rows are 14, `openRows` and `invalidRows` contain the missing id, and the missing row has `missing_required_row`.
- Assert `summaryClass !== "full_roadmap_complete"`, `allRowsClosed === false`, and `evaluateParentRoadmapClaim` blocks `Full roadmap complete.` in enforce mode.
- Assert serialized ledger, rollup, and claim decision do not contain elevated claim terms: Authority, fullAuthority, production, independent two-host completion, or two-host completion.

**Verify**:

- Run `npm --prefix packages/main run build`.
- Run `node packages/main/dist/tasks/parent-roadmap-large-ledger-g02-baseline-smoke.js`.
- The command must print `parent-roadmap large-ledger G02 baseline smoke PASS`.

## CHK-002 Bind G02 baseline to documentation boundaries

**Files**:

- Modify `docs/requirements/decisions/unattended-develop-mode-no-false-done-baseline.md` only.

**Implementation**:

- Update status and implementation progress from G01-only to G01-G02 implemented only.
- Add the runnable G02 command beside the G01 command.
- Mark G02 as implemented in the implementation progress table, while keeping G03-G10 future.
- Add a short G02 evidence note that this is the missing-row negative control and that it blocks full completion.
- Keep every full 10x15 claim explicit that the full baseline remains incomplete until G03-G10 are implemented.

**Verify**:

- Run the same G02 smoke command.
- Run `node packages/main/dist/tasks/retired-authority-vocabulary-guard-smoke.js`.
- Spot-check the document with `rg -n "G01-G02|G02|G03|G10|full 10x15 baseline is not complete|parent-roadmap-large-ledger-g02" docs/requirements/decisions/unattended-develop-mode-no-false-done-baseline.md`.

## Review And DONE Gates

- Before DEV: `intent_coverage_check` and `proofstory_gate_check` must pass in enforce mode.
- Before REVIEW: both checklist items must carry verificationEvidence for their happy, edge, and adversarial intents.
- Before DONE: `proofstory_review_completeness_check`, `done_intent_equivalence_check`, routine `lattice validate`, and configured DONE-required validation must pass or explicitly report no blocking policy.
