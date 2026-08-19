# B-727b Execution Plan

## Intent Boundary

Implement only G03 of the UDM no-false-DONE 10x15 baseline. G03 is the prose-only negative control: all 15 required G03 rows are present and contain completion wording, but none has command-backed closure evidence. The parent-roadmap rollup must leave all rows open due to missing evidence and must block full roadmap completion wording. G04-G10 remain future work, and this story must not claim full 10x15 completion or elevated rollout assurance.

## CHK-001 Add the G03 prose-only negative-control baseline smoke

**Files**:

- Create `packages/main/src/tasks/parent-roadmap-large-ledger-g03-baseline-smoke.ts`.
- Do not modify `packages/main/src/core/parent-roadmap-totality.ts`.

**Implementation**:

- Mirror the G01/G02 task shape but use `GROUP_ID = "G03"`, story id `B-727b`, and G03-specific ledger ids, row ids, hashes, command text, artifact refs, and claim boundary.
- Build a required inventory of exactly `G03-M01` through `G03-M15`.
- Generate exactly 15 rows. Each row should contain explicit completion prose in user-facing fields but must have `closureEvidence: []`.
- Evaluate through `evaluateParentRoadmapLedger` and assert: `rowResults.length === 15`, generated rows are 15, closed rows are 0, `openRows.length === 15`, `invalidRows.length === 0`, `staleEvidenceRows.length === 0`, `deferredRows.length === 0`, and `migrationRows.length === 0`.
- Assert every row has `evidenceState === "missing"` and reason code `missing_closure_evidence`.
- Assert `summaryClass !== "full_roadmap_complete"`, `claimType === "no-full-roadmap-claim"`, and `allRowsClosed === false`.
- Add a fake caller-supplied parent rollup or completion wording in the ledger context and assert the evaluator recomputes from row evidence rather than trusting it.
- Assert `evaluateParentRoadmapClaim` blocks `Full roadmap complete.` in enforce mode.
- Assert serialized ledger, rollup, and claim decision do not contain elevated claim terms: Authority, fullAuthority, production, independent two-host completion, or two-host completion.

**Verify**:

- Run `npm --prefix packages/main run build`.
- Run `node packages/main/dist/tasks/parent-roadmap-large-ledger-g03-baseline-smoke.js`.
- The command must print `parent-roadmap large-ledger G03 baseline smoke PASS`.

## CHK-002 Bind G03 baseline to documentation boundaries

**Files**:

- Modify `docs/requirements/decisions/unattended-develop-mode-no-false-done-baseline.md` only.

**Implementation**:

- Update status and implementation progress from G01-G02-only to G01-G03 implemented only.
- Add the runnable G03 command beside the G01 and G02 commands.
- Mark G03 as implemented in the implementation progress table, while keeping G04-G10 future.
- Add a short G03 evidence note that this is the prose-only negative control and that prose without machine evidence blocks full completion.
- Keep every full 10x15 claim explicit that the full baseline remains incomplete until G04-G10 are implemented.

**Verify**:

- Run the same G03 smoke command.
- Run `node packages/main/dist/tasks/retired-authority-vocabulary-guard-smoke.js`.
- Spot-check the document with `rg -n "G01-G03|G03|G04|G10|full 10x15 baseline is not complete|parent-roadmap-large-ledger-g03" docs/requirements/decisions/unattended-develop-mode-no-false-done-baseline.md`.

## Review And DONE Gates

- Before DEV: `intent_coverage_check` and `proofstory_gate_check` must pass in enforce mode.
- Before REVIEW: both checklist items must carry verificationEvidence for their happy, edge, and adversarial intents.
- Before DONE: `proofstory_review_completeness_check`, `done_intent_equivalence_check`, routine `lattice validate`, delivery check, DONE-required validation, and review assurance floor must pass.
