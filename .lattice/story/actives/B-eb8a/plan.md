# Plan

This story is a docs-only policy sync. The canonical rule will live in story-lifecycle.md, which will explicitly say that annotation compliance / pure typo / wording-only changes are low-risk one-round cases. The adjacent runbooks will reference that same rule, and the stronger three-round two-host path for lifecycle, gate, Authority, and process-fact work will stay intact.

## CHK-001

Goal: make the low-risk one-round policy explicit in the canonical decision docs.

Files to modify:
- docs/requirements/decisions/story-lifecycle.md
- docs/requirements/decisions/done-closure-runbook-assistant-execution-plan.md
- docs/requirements/decisions/scope-check-missing-guidance-execution-plan.md

Steps:
1. Update story-lifecycle.md so the canonical text names annotation compliance, pure typo-only, and wording-only changes as one-round cases.
2. Sync the two adjacent runbooks so they reference the same canonical rule instead of rephrasing it differently.
3. Keep the scope strictly docs-only and keep the local Non-authority / Authority Server boundary unchanged.

Validation:
- Run rg -n "annotation compliance|pure typo|wording-only|one-round|three-round" docs/requirements/decisions/story-lifecycle.md docs/requirements/decisions/done-closure-runbook-assistant-execution-plan.md docs/requirements/decisions/scope-check-missing-guidance-execution-plan.md docs/requirements/decisions/three-round-two-host-review-escalation-execution-plan.md and confirm the low-risk wording is aligned.
- Run lattice story_review --storyId=B-eb8a and confirm CHK-001 no longer reports the canonical-doc mismatch.

## CHK-002

Goal: preserve the stronger three-round two-host rule for high-risk work.

Files to modify:
- docs/requirements/decisions/story-lifecycle.md
- docs/requirements/decisions/three-round-two-host-review-escalation-execution-plan.md

Steps:
1. Keep the three-round rule intact for lifecycle, gate, Authority, and process-fact work.
2. Make the low-risk one-round bucket explicitly narrow so it does not broaden the high-risk path.
3. Keep the docs from claiming Authority Server completion or any runtime gate change.

Validation:
- Run rg -n "three-round|Authority Server completion|local Non-authority|high-risk" docs/requirements/decisions/story-lifecycle.md docs/requirements/decisions/three-round-two-host-review-escalation-execution-plan.md and confirm the high-risk rule still reads the same.
- Run lattice story_review --storyId=B-eb8a and confirm the story still distinguishes the low-risk one-round bucket from the high-risk three-round path.
