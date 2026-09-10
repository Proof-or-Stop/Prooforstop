# U-06 exact legacy scope-budget migration

This Lab adds an optional, explicit project-governance migration manifest. It does not enable the repository policy by itself, declare any real Story DONE, or issue a signed large-Story approval.

A read-only `scope_budget_check` exports the complete versioned subject projection and digest through `legacySnapshot`. A reviewed manifest fixes the Story ID, creation identity, captured DEV/REVIEW/TEST phase and that exact subject. Progress and verification receipts are excluded from the subject; requirements, scope, withdrawals, acceptance topology and unknown fields remain bound. An authorized return to PLAN or INIT_CHECK can consume the same capture; new, recreated, terminal or changed subjects cannot. Both proposed and base amendment subjects must still match the persisted subject.

The exception affects only the newly introduced scope budget. Invalid policy and canonical command mappings, incomplete decomposition, filesystem aliases/traversal and independent lifecycle prerequisites remain blocking. Path safety is checked independently of ordinary budget accounting: missing acceptance topology cannot skip the path check. Read-only capture is diagnostic data, not a grant or signed approval.

The regression reuses the existing restricted synthetic Git/Story fixture, calls the real read-only handler, exercises all three actual DEV guards, and invokes the real `checklist_update` progress operation. It also checks changed creation identity, requirements and paths; missing/duplicate/unknown manifest entries; malformed command policy; unsafe paths with absent proof; changed next/base amendments; and the independent REVIEW inventory gate.

## Lab evidence

Regression commit: `19b0414992`.
Pinned command: `node scripts/verify-scope-budget-legacy-guards.mjs`.
RED: the real read-only handler lacked the required snapshot export; Lab recorded the exact `read-only legacy snapshot export is required` failure.

The first full build rejected an internal synthetic policy-probe cast. The repair validates policy and command groups directly instead of constructing an incomplete Story. The corrected full build and compiled real-guard regression passed. Existing semantic-budget, canonical-command identity, explicit approval and decomposition regressions also passed, as did the process-fact contract. The Lab runner verifies the same pinned command against the repair commit before recording GREEN.

## Activation boundary

Root policy activation and actual legacy-entry capture require separate current evidence. Layer-based ownership maps were rejected because they turn a normal core/handler/test/docs repair into multiple artificial responsibilities. Repository activation uses reviewed functional boundaries.

The subject v2 repair supports only a literal directory prefix followed by `/**`.
It binds sorted physical path membership, with a 10,000-entry and 32-level bound.
Adding or removing members invalidates the capture; editing member bytes does not
change scope. Interior symlinks, unsafe paths, root retargeting and directory
identity changes are refused. A legitimate lexical alias of the project root is
canonicalized. This is a bounded traversal with identity rechecks, not an atomic
filesystem snapshot. Existing v1 digests require fresh capture.

Regression commit `36170dc81a` invokes the actual compiled CLI twice against an
isolated fixture. Its fixed `U06_LEGACY_GLOB_CLI_REQUIRED` assertion failed with
`unknown` on the old implementation. After repair, the same compiled CLI returned
`legacy_subject_preserved`. The physical-path boundary suite and all existing
real-guard assertions passed. Independent static review found no blocker. The
first build exposed an overloaded fs type inference issue, corrected by using
the actual non-optional `Stats` type; the subsequent build passed.
