# B-5082 Plan: Complete Remaining ProofStory M0-M9 Commitments

## Completion Rule

No checklist item may be marked `done` and no user-facing ✅ may be shown until that item has all three evidence classes:

1. Document commitment evidence: exact section/line from `docs/requirements/decisions/proofstory-intent-collision-execution-plan.md`.
2. Implementation evidence: changed code/prompt/document paths and the behavior they implement.
3. Verification evidence: focused smoke or process-fact contract output covering the item.

## CHK-001 Add ProofStory guidance to active reviewer prompts and story_review advisory rendering

Document check before completion:
- M0 requires updated guide/prompt vocabulary and ProofStory pre-DEV guidance.
- M3 requires story_review advisory rendering for intent collision artifacts.
- M8 requires documented REVIEW critic orchestration in active prompts.

Implementation plan:
- Add ProofStory diagnostics rendering to `story_review` as advisory/blocker according to current policy.
- Add active reviewer prompt guidance for concept, quality, docs, and test-coverage lanes in both Codex and Claude prompt mirrors.
- Ensure prompt wording remains English and says gates consume structured artifacts, not prompt prose.

Verification before ✅:
- Smoke proves story_review surfaces ProofStory advisory diagnostics.
- Process-fact contract proves prompt guidance has corresponding hard CLI/gate support.

## CHK-002 Add ledger assignment fields for parent and child story slicing

Document check before completion:
- M1 requires optional parent ledger and assigned Story fields that do not force one milestone to become one Story.

Implementation plan:
- Extend milestone ledger item types and normalization with optional `parentLedgerId`, `assignedStoryId`, and `assignedStoryRole` fields.
- Preserve backwards compatibility for ledgers without assignment fields.
- Validate assignment field shapes before writing artifacts.

Verification before ✅:
- Smoke sets and gets assigned and unassigned milestone rows.
- Invalid assignment rows fail before artifact corruption.

## CHK-003 Implement slice-plan artifact and oversized ledger exception semantics

Document check before completion:
- M2/M4/M9 require oversized ledgers to produce sizing diagnostics and block DEV in enforce mode unless a slice plan or child-story assignment exists.

Implementation plan:
- Add a gate-consumed `slice-plan.json` artifact with command support.
- Diagnostics should distinguish suggested slices from accepted slice plans.
- Enforce mode should allow oversized ledgers only when every required milestone is assigned through a complete slice plan or child assignment.
- Do not auto-create child stories.

Verification before ✅:
- Smoke proves complete slice plan clears oversized ledger blocking.
- Smoke proves incomplete/stale slice plan does not bypass the gate.

## CHK-004 Implement parent ledger roll-up checks for child-story coverage

Document check before completion:
- M5 requires parent ledger roll-up checks for child-story coverage after slice-plan artifacts exist.

Implementation plan:
- Add a `parent-ledger-rollup.json` artifact or equivalent gate-consumed roll-up structure.
- DONE equivalence should consume roll-up evidence for parent stories when a slice plan exists.
- Missing required child coverage remains blocking in enforce mode.

Verification before ✅:
- Smoke proves complete parent roll-up passes DONE equivalence.
- Smoke proves missing child coverage blocks parent DONE equivalence.

## CHK-005 Implement lightweight single-outcome DONE equivalence

Document check before completion:
- M5 requires ordinary single-outcome DONE to use lightweight summary-to-snapshot equivalence, while milestone/shrinkage/high-assurance stories use strict equivalence.

Implementation plan:
- Update DONE intent equivalence to avoid requiring confirmed milestone ledger for ordinary single-outcome stories.
- Compare summary/delivery text against the original intent snapshot enough to catch obvious narrow claims.
- Keep strict ledger checks for milestone or high-assurance stories.

Verification before ✅:
- Smoke proves a single-outcome story passes without a ledger.
- Smoke proves narrower DONE claims still require confirmed shrinkage.

## CHK-006 Bind red evidence to baseline head/material and green relation

Document check before completion:
- M6 requires red evidence baseline head/material binding and transition relation to current green evidence.

Implementation plan:
- Extend red evidence records with baseline head/material fields and acceptance/green relation fields.
- Require triggered red evidence to match a ProofStory acceptance binding or milestone evidence target.
- Keep docs-only stories free from red evidence requirements.

Verification before ✅:
- Smoke proves bound red evidence satisfies triggered diagnostics.
- Smoke proves wrong-target or stale red evidence does not satisfy diagnostics.

## CHK-007 Add spike disposable-code policy checks

Document check before completion:
- M7 requires disposable-code policy checks and prevents spike code from silently carrying into implementation.

Implementation plan:
- Extend spike records with disposable code path fields and a carry policy.
- Diagnostics should block active disposable spike code in enforce mode until discarded or explicitly promoted.
- Promotion remains audit metadata and does not auto-create red or verification evidence.

Verification before ✅:
- Smoke proves active disposable spike blocks enforce mode.
- Smoke proves discard/promote resolves the disposable-code diagnostic without auto-satisfying red/green evidence.

## CHK-008 Close risk-adaptive high-assurance review policy behavior

Document check before completion:
- M8/M9 require high-assurance stories to get stronger review/completeness diagnostics while low-risk stories stay lightweight.

Implementation plan:
- Extend diagnostics to report high-assurance review/completeness expectations clearly.
- Preserve standard-trigger semantics for ambiguity, user impact, behavior change, and multi-path interpretation.
- Ensure existing reviewer evidence freshness and reviewRunId binding remain the authoritative REVIEW path.

Verification before ✅:
- Smoke proves high-assurance stories cannot bypass required evidence in enforce mode.
- Smoke proves low-risk docs-only stories avoid unnecessary red/spike overhead.
