# Plan for B-e1a8

## CHK-001 Enable ProofStory enforce modes in project config

Modify only lattice.config.json by adding a top-level proofStory object. Set devGateMode, reviewGateMode, and doneGateMode to enforce. Do not change core/machine.ts or phase-gates.ts unless verification proves the existing enforcement hooks are broken. After editing, inspect the diff to confirm this is a config-only rollout.

## CHK-002 Record ProofStory intent artifacts for this rollout story

Keep the rollout self-contained by recording an original intent snapshot, a confirmed milestone ledger for the three configured gates, an accepted intent collision decision, and a ProofStory contract binding all checklist verificationIntent refs. The ledger is an intent coverage artifact only; it must not create child stories or expand scope.

## CHK-003 Verify DEV REVIEW DONE gate behavior under enforce mode

After the config change, run build, process fact contract verification, ProofStory hardening smoke, proofstory_gate_check mode=enforce, proofstory_review_completeness_check mode=enforce, and done_intent_equivalence_check mode=enforce for B-e1a8. Record passing verificationEvidence for every verificationIntent ref before entering REVIEW/TEST/DONE.

## Rollback

If enforcement causes a verified gate bug rather than expected missing-artifact blocking, revert the proofStory config change in this story and open a separate bug story for the implementation defect. Do not silently downgrade to observe without explicit user approval.
