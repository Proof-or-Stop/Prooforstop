# Execution Plan: B-b5c0

## Boundary

This story repairs only `docs/requirements/decisions/lattice-strengthening-roadmap-execution-plan.md`. `docs/requirements/NAV.md` may be touched only if the title or navigation entry needs adjustment; no runtime code, handlers, gates, Authority implementation, baseline runners, hooks, or fixtures are in scope.

## STOP Conditions

- Stop before editing if the required fix would change runtime behavior rather than documentation.
- Stop before claiming 3x2 success if either host fails any round or if `autopilot_review_status` reports `localReviewCertified:false`.
- Stop before DONE if validation evidence is stale or if reviewer findings identify unresolved high/critical document gaps.
- Stop if the active unrelated B-491e story requires touching the same files; this story must not coordinate or modify B-491e artifacts.

## CHK-001

Goal: clarify current implementation baseline and source mapping.

Actions:
- Add Authority receipt and lifecycle receipt consumption source documents to Source And Context Mapping.
- Add a current implementation status section/table that distinguishes shipped, partial/harden-existing, planned, and greenfield work.
- Update M1-M3 and M9-M10 language so existing INIT scope gates, owner leases, main lock, session ownership rendering, parallel wave, and baseline surfaces are consumed or hardened rather than treated as net-new behavior.
- Clarify that lifecycle metadata may appear as story provenance while the material/product diff for B-8b07 was the document and NAV.

Validation:
- `rg` checks for the new source refs and current-status language.
- `git diff -- docs/requirements/decisions/lattice-strengthening-roadmap-execution-plan.md` review for no runtime claims.

## CHK-002

Goal: make review escalation and validation requirements mechanical.

Actions:
- Add an explicit `requires3x2` predicate that preserves the existing first REVIEW round countable-problem trigger and separately names explicit high-risk policy opt-in.
- Replace ambiguous local verdict wording with counted-verdict requirements: host/session/key/material/validation/prompt binding and signed or registry-backed identity payload where local policy counts it.
- Add minimal validation command/artifact expectations for M0, M6, M8, M12, and the final 3x2 review.
- Clarify local host evidence does not set Authority completion fields.

Validation:
- `rg` checks for `requires3x2`, `signature`, `review_escalation_status`, `autopilot_review_status`, and validation command references.
- `git diff --check` and build verification.

## CHK-003

Goal: specify rollout crosswalk and recovery controls.

Actions:
- Add a milestone-to-rollout stage crosswalk with policy version, enforcement mode, and expected operator-visible artifact/command evidence.
- Define in-flight story treatment when policy changes after PLAN/DEV/REVIEW.
- Add false-positive rollback/de-escalation rules and an audited emergency bypass for self-hosting gate over-block.
- Make M11 runbook/repair dry-run prerequisites staged before any new blocker is enabled.
- Align dependency wording where milestone table and sequencing previously diverged.

Validation:
- `rg` checks for rollout policy/version, in-flight treatment, emergency bypass, rollback/de-escalation, and crosswalk content.
- Final 3 round 2 host audit over the repaired document.

## Final Validation

- `git diff --check`
- `npm --prefix packages/main run build`
- `lattice validate --story=B-b5c0`
- Three local review rounds with Codex and Claude Code using the same material anchors; each round must show two independent PASS verdicts before claiming full local 3x2 review.
