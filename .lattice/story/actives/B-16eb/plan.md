# Execution Plan

## Execution Boundary

Allowed work:
- Audit and revise `docs/requirements/decisions/decision-doc-promotion-execution-plan.md`.
- Update `docs/requirements/NAV.md` only to register or align the decision document entry.
- Record Lattice lifecycle metadata, verification evidence, review passes, and decision-doc quorum evidence for B-16eb.

Explicitly out of scope:
- Implementing `decision_doc_proposal`, `decision_doc_preview`, or `decision_doc_save`.
- Changing CLI behavior, process registries, Authority semantics, configurable path policy, productionDone semantics, or DONE gate implementation.
- Editing unrelated requirements documents or source files.

STOP conditions:
- Stop and ask the user before touching any file outside the allowed paths.
- Stop and open a scope extension before converting this document audit into implementation work.
- Stop if decision_doc_quorum_check cannot pass without changing production code.
- Stop if reviewers disagree for more than five exchanges or identify a contradiction requiring product decision.

## CHK-001

Move the already drafted execution plan into the B-16eb worktree and keep it tied to the story lifecycle. Confirm the decision doc and NAV entry are present as worktree material changes, and confirm no implementation files are included in this docs-only story.

Verification:
- `git status --porcelain` and `git diff --name-only` show only allowed document material changes plus Lattice metadata.
- `test -f docs/requirements/decisions/decision-doc-promotion-execution-plan.md` confirms the document exists.

## CHK-002

Audit the execution plan content for the boundaries already requested by the user: scope anti-expansion, digest/freshness checks, and local quorum language that does not claim Authority or production completion. Patch only the decision document or NAV if the audit finds wording gaps.

Verification:
- Text checks confirm the plan contains scope, freshness, verificationRequirements, local-only quorum, and non-Authority boundaries.
- Text checks confirm the plan does not prescribe source implementation changes in this story.

## CHK-003

Run the decision-doc quorum workflow against the final decision document digest: three rounds, two distinct host IDs per round, structured `host_verdict` evidence, all passing for the current material digest. Use `decision_doc_quorum_check` before and after evidence recording so the story proves both the missing-evidence failure mode and the final pass mode.

Verification:
- Pre-check: `lattice decision_doc_quorum_check --storyId=B-16eb` reports missing or insufficient quorum before verdicts are recorded.
- Evidence: six structured host verdicts exist across rounds 1-3 and two hosts per round for the current digest.
- Final check: `lattice decision_doc_quorum_check --storyId=B-16eb` reports pass.

## Commit And Phase Plan

1. Complete PLAN blockers: verificationIntent, plan.md, and reviewer-written scope-check.
2. Advance to DEV.
3. Verify and commit document changes.
4. Record checklist evidence and complete each checklist item after the relevant commit/evidence exists.
5. Advance through REVIEW with reviewer lanes.
6. Run TEST validation, record any required evidence, then advance DONE only after decision-doc quorum and validation gates pass.
