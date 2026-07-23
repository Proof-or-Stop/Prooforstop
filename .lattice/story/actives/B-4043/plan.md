# B-4043 Wave 4 implementation plan

## CHK-001
Integrate canonical role guidance in the mirrored Codex and Claude implementer/reviewer prompts. Prompts name acceptance_topology_check, pre_review_check_read, acceptance_rollout_report/check, current receipt requirements, full-3x2 boundary, and rollback behavior. Runtime facts remain enforced by handlers/gates; prompt prose never supplies evidence. Add mirror/contract assertions so one host cannot drift.

## CHK-002
Add a versioned verifier-owned acceptance rollout cohort/report model. Registered case records cover comparable baseline and candidate high-assurance Stories, seeded omission/forgery defects, docs-only/legacy/single-outcome false-block controls, review rounds, waiver counts, check inventory, cost and quorum class. Derive aggregates and PASS/FAIL deterministically, bind source case records, project version, thresholds, story/material hashes and provider/quorum evidence, persist through Store, and reject caller verdict/aggregate fields. Provide read/write CLI with stable diagnostics and a real reproducible cohort runner/transcript.

## CHK-003
Define a flat project rollout policy: transcripts required for user-visible and orchestration claims; mutations required for behavior/lifecycle/proof/safety with docs-only exemption; only registered supported adapter profiles can count complete; minimum comparable sample count is 3; supported seeded omission detection is 100%; false-block rate is 0%; mislabeled 3x1 is 0; waiver delta must be <=0; check inventory may not shrink. Unknown/partial adapters or insufficient samples fail promotion with deterministic codes.

## CHK-004
Make opt-in enforce mechanically consume a current signed PASS rollout receipt plus current full-3x2 quorum. Observe and warn retain identical status/diagnostics; enforce alone blocks admission. Missing/stale/tampered receipt, failed thresholds, degraded quorum, positive waiver delta or weaker checks fail closed. Implement rollback to observe/warn as a policy/config change only; never rewrite/delete reports or prior evidence. Test clean control, targeted real-consumer mutations, named failure, restoration and clean control.

## CHK-005
After executable cohort and enforcement tests pass, update the canonical Story 6 execution plan and CLI documentation. Record exact thresholds, measured cohort output, commands, implemented flat boundary, rollback steps and authority wording. Change Wave 4 status only to the actually demonstrated state, keep Wave 3A explicitly unimplemented/excluded, and do not claim production/public authority beyond local full-3x2 evidence.

## Sequencing and verification
Implement core types/evaluator/store first, then handlers/catalog/policy/gate consumption, then prompt mirrors and docs. Add focused smoke and process-fact contract before running the real cohort transcript. Build and focused tests run during DEV; four independent REVIEW lanes and one formal 3 rounds x 2 hosts quorum run after all checklist evidence is current. TEST runs fresh lattice validate and DONE-required validation once each, single-instance.
