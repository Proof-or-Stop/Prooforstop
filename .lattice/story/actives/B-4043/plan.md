# B-4043 Wave 4 implementation plan

## CHK-001
Integrate canonical role guidance in mirrored Codex and Claude prompts for implementer, verification-intent compatibility (`test-case-reviewer`), topology critic, and concept/quality/test-coverage/docs/delivery reviewers. Every role names acceptance_topology_check, pre_review_check_read, acceptance_rollout_report/check, current receipt requirements, full-3x2 boundary, and rollback behavior appropriate to its lane. Runtime facts remain enforced by handlers/gates; prompt prose never supplies evidence. Add exact mirror/contract assertions so one host or lane cannot drift.

## CHK-002
Add a versioned verifier-owned acceptance rollout cohort/report model. Cohort membership is derived and frozen by the verifier from every eligible comparable high-assurance Story/case in a declared evaluation window; callers cannot select or omit rows. Require at least 3 paired comparable samples per arm (>=3 baseline and >=3 candidate). Registered case records cover all seeded omission/forgery defect classes, docs-only/legacy/single-outcome false-block controls, review rounds, waiver counts, check inventory, cost and quorum class. Derive aggregates and PASS/FAIL deterministically, bind eligibility rule, full membership, source records, project/threshold version, story/material hashes and provider/quorum evidence, persist through Store, and reject caller verdict/aggregate fields. Provide read/write CLI with stable diagnostics and a reproducible runner that creates real temporary Story flows rather than synthetic-only aggregates.

## CHK-003
Define a flat project rollout policy: transcripts required for user-visible and orchestration claims; mutations required for behavior/lifecycle/proof/safety with docs-only exemption; only registered supported adapter profiles can count complete; minimum cohort is 3 paired samples per arm; every registered seeded defect must be detected (overall false-pass rate 0 and supported omission detection 100%); false-block rate 0; mislabeled 3x1 count 0; waiver delta <=0; check inventory non-shrinking. Unknown/partial adapters, incomplete registered campaigns, insufficient samples, membership drift or unexplained disagreement fail promotion with deterministic codes.

## CHK-004
Make opt-in enforce mechanically consume a current signed PASS rollout receipt plus current full-3x2 quorum. Observe and warn retain identical status/diagnostics; enforce alone blocks admission. Missing/stale/tampered receipt, failed thresholds, degraded quorum, positive waiver delta or weaker checks fail closed. Implement rollback to observe/warn as a policy/config change only; never rewrite/delete reports or prior evidence. Test clean control, targeted real-consumer mutations, named failure, restoration and clean control.

## CHK-005
After executable cohort and enforcement tests pass, update the canonical Story 6 execution plan and CLI documentation. Record exact thresholds, frozen membership rule, measured cohort output, commands, implemented flat boundary, rollback steps and authority wording. Change Wave 4 status only to the demonstrated state, keep Wave 3A explicitly unimplemented/excluded, and do not claim production/public authority beyond local full-3x2 evidence.

## Sequencing and verification
Implement core types/evaluator/store first, then handlers/catalog/policy/gate consumption, then prompt mirrors and docs. Add focused smoke and process-fact contract before running the real cohort transcript. Build and focused tests run during DEV; four independent REVIEW lanes and one formal 3 rounds x 2 hosts quorum run after all checklist evidence is current. TEST runs fresh lattice validate and DONE-required validation once each, single-instance.
