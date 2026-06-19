# B-7adb Execution Plan

## Execution Boundary

Do: improve local review-assurance diagnostic output, voluntary local 3x2 visibility, and stale-material recovery guidance.

Do not: change lifecycle pass/fail predicates, add server-backed proof workflows, run external host orchestration, or create new completion semantics.

STOP if implementation requires changing DONE gate logic rather than reporting existing facts, if the scope contract blocks a file, or if validation shows stale evidence caused by unrelated active stories.

## CHK-001

Goal: `autopilot_review_status` should no longer mislead operators when custom run ids contain the useful verdicts and `default-run` is empty.

Implementation:
- Extend local verdict summarization with an additive all-runs/latest-runs projection.
- Preserve current `runId` behavior and existing top-level fields for compatibility.
- Keep local status flags non-server-backed and diagnostic-only.

Validation:
- Add smoke assertions for default-run plus custom run summaries.
- Run `node packages/main/dist/tasks/planner-unattended-smoke.js` or a focused built smoke after build.

## CHK-002

Goal: `review_escalation_status` should show voluntary local 3x2 rounds even when escalation is not required.

Implementation:
- Evaluate host verdict rounds for diagnostics before/alongside the `required=false` return path.
- Add a voluntary local rounds section to the report without changing `ok`, `required`, or `assuranceLevel`.
- Render text that makes the optional nature clear.

Validation:
- Extend `review-escalation-smoke` for required=false with and without submitted local rounds.
- Confirm triggered escalation behavior still passes existing checks.

## CHK-003

Goal: stale-material DONE failures should tell the operator what became stale and what to do next.

Implementation:
- Improve `formatReviewAssuranceFloorFailure` stale/ignored verdict output with a concise recovery runbook.
- Include current material hash context and refresh/resubmit command hints.
- Avoid any bypass wording or predicate changes.

Validation:
- Extend `review-assurance-floor-smoke` to assert stale verdict details and runbook lines.
- Confirm normal one-round and high-risk paths still pass.

## CHK-004

Goal: the diagnostic UX is observable in tests and documented as local diagnostics.

Implementation:
- Update relevant decision docs to describe all-runs/latest-runs, voluntary rounds, and stale-material recovery guidance.
- Keep docs explicit that this is not new remote proof or lifecycle completion behavior.
- Tie docs to the same smoke coverage used for CHK-001 through CHK-003.

Validation:
- Run build and focused smoke tasks.
- Run `lattice validate --story=B-7adb`.
- Run local 3 rounds x 2 hosts review evidence before DONE because this touches Lattice core review/closure UX.
