# B-e781 Execution Plan

## Goal

Complete the remaining lattice strengthening roadmap rows M4-M12 with machine evidence. The final observable result is that `parent_roadmap_status --storyId=B-43de --json` reports no open M4-M12 rows, the roadmap document no longer states that M4-M12 remain follow-up implementation milestones, and every B-e781 checklist item has fresh verification evidence.

## Boundaries

- Do not use or touch `.omx` or `omx`.
- Do not mutate unrelated active story metadata.
- Do not resurrect Authority Server production/runtime semantics.
- Do not mark a row closed by prose alone.
- Keep read-only/advisory surfaces labelled as read-only/advisory in claim text.

## Rollback

If any row cannot be proven by runnable evidence, keep that row open in the parent roadmap rollup, record the exact missing evidence, and do not claim M4-M12 complete. Revert only B-e781 changes if the rollup cannot honestly close.

## CHK-001

Close M4 process fact registry coverage.

Implementation steps:
- Audit the process fact registry entries for the ProofStory, slice-plan, parent-ledger, scope-contract, review/quorum, baseline, rollout, and handoff facts used by M4-M12.
- Add or adjust registry rows only if the verifier shows a real missing gate-consumed fact.
- Update the parent roadmap M4 row with evidence refs for the registry verifier and parent rollup.

Verification:
- Run `node scripts/verify-process-fact-contract.mjs`.
- Run `node bin/lattice.js parent_roadmap_status --storyId=B-43de --json` and verify M4 is closed.
- Run the parent-roadmap totality smoke after code changes.

## CHK-002

Close M5 verification context pack and evidence envelope standardization.

Implementation steps:
- Verify existing context pack create/expand and evidence envelope behavior is represented in the roadmap row.
- Preserve the context pack command boundary as local CLI evidence, not external Authority proof.
- Update roadmap wording from future child-story-needed to evidence-backed closed status.

Verification:
- Run `node packages/main/dist/tasks/verification-context-pack-smoke.js`.
- Run parent roadmap status and verify M5 is closed with that evidence ref.

## CHK-003

Close M6 gate oracle freshness and negative-control matrix.

Implementation steps:
- Represent current local lifecycle freshness, expected-block, and negative-control coverage in the M6 row.
- Do not claim retired Authority Server runtime behavior.
- Ensure parent roadmap smoke rejects stale/open rows and accepts the final closed ledger.

Verification:
- Run the M6-related smoke evidence listed in the row.
- Run `node packages/main/dist/tasks/parent-roadmap-totality-smoke.js`.
- Run parent roadmap status and verify M6 is closed.

## CHK-004

Close M7 baseline suite formalization.

Implementation steps:
- Bind baseline suite and report smokes to the M7 row.
- Keep report math and claim boundaries explicit in the roadmap document.
- Ensure baseline evidence is listed as local machine evidence.

Verification:
- Run `node packages/main/dist/tasks/baseline-suite-smoke.js`.
- Run `node packages/main/dist/tasks/baseline-suite-report-smoke.js`.
- Run parent roadmap status and verify M7 is closed.

## CHK-005

Close M8 host identity, review-run, and 3x2 quorum strengthening.

Implementation steps:
- Bind review escalation, reviewer quorum, and quorum submit smokes to the M8 row.
- Document full 3x2 and degraded 3x1 local assurance boundaries without overclaiming host independence.
- Keep ignored stale/duplicate/missing-signature verdict cases represented by the smoke refs.

Verification:
- Run `node packages/main/dist/tasks/review-escalation-smoke.js`.
- Run `node packages/main/dist/tasks/reviewer-quorum-smoke.js`.
- Run `node packages/main/dist/tasks/quorum-submit-smoke.js`.
- Run parent roadmap status and verify M8 is closed.

## CHK-006

Close M9 preflight command center.

Implementation steps:
- Bind lifecycle orchestration smoke to M9.
- Ensure the roadmap says the command center renders canonical gate/preflight rows and does not mutate evidence or create renderer-only rules.
- Preserve read-only command boundaries.

Verification:
- Run `node packages/main/dist/tasks/lifecycle-orchestrate-smoke.js`.
- Run parent roadmap status and verify M9 is closed.

## CHK-007

Close M10 parallel collaboration scheduling.

Implementation steps:
- Bind lattice parallel wave smoke to M10.
- Document scheduling as advisory/non-authoritative and integrated with owner lease/review boundaries.
- Do not claim automatic parallel story execution as a hard requirement for all large ledgers.

Verification:
- Run `node packages/main/dist/tasks/lattice-parallel-wave-smoke.js`.
- Run parent roadmap status and verify M10 is closed.

## CHK-008

Close M11 rollout migration and operator guidance.

Implementation steps:
- Bind rollout-check smoke and roadmap operator guidance updates to M11.
- Update stale wording that says M4-M12 remain future follow-up implementation work.
- Keep compatibility and in-flight story treatment explicit.

Verification:
- Run `node packages/main/dist/tasks/rollout-check-smoke.js`.
- Run `git diff --check`.
- Run parent roadmap status and verify M11 is closed.

## CHK-009

Close M12 cross-track certification and handoff package.

Implementation steps:
- Close M12 only after M4-M11 are represented as closed by evidence.
- Bind handoff smoke and final parent-roadmap totality smoke to M12.
- Produce final parent ledger roll-up evidence for B-e781.

Verification:
- Run `node packages/main/dist/tasks/lattice-handoff-smoke.js`.
- Run `node packages/main/dist/tasks/parent-roadmap-totality-smoke.js`.
- Run `node bin/lattice.js parent_roadmap_status --storyId=B-43de --json` and verify all M4-M12 rows are closed.
