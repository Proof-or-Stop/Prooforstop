# Plan: Harden proof-or-stop PINN execution plan wording and benchmarks

## CHK-001
- Keep the document terminology bound to Proof-or-Stop-only language and prevent over-claiming language that implies PDE correctness.
- Confirm scope/status wording stays explicit: design draft, documentation-only, and no runtime changes in this story.

## CHK-002
- Lock benchmark baseline-fairness constraints so A1/A2/A3/A4 keep PDE/domain/model/budget/seed/grid/verifier fixed.
- Add deterministic constraints in a dedicated section so every future comparator run is auditable and apples-to-apples.

## CHK-003
- Define a concrete benchmark task set with reproducible reference tasks and a bounded failure-injection list B1–B15.
- Ensure the benchmark purpose is admissibility-control effectiveness, not PDE solver performance.

## CHK-004
- Replace ambiguous legacy naming with Proof-or-Stop boundary language.
- Remove/avoid statements that imply full scientific/production correctness; keep claim-boundary semantics explicit.

## CHK-005
- Replace vague “acceptable” success language with concrete measurable metrics and report expectations.
- Include failure/reason reporting requirements for false-stop and stale-evidence handling.

## CHK-006
- Finalize publication posture and governance boundary paragraphs.
- Ensure downstream docs can consume this safely as a future-domain extension without overclaim.

## CHK-007
- Clarify completion axis: which milestones are documentation-complete versus runtime-deliverable deferred.
- Add milestone framing so future implementers cannot mistake doc completion for shipped implementation.
