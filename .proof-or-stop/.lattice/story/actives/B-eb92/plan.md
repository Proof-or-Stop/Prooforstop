## B-eb92 Plan

Implement review-assurance surfacing and safe blocker guidance without changing DONE pass criteria or writing any reviewer/host/delivery evidence from the owner lane. The implementation order follows the user-visible flow: central predicate-derived guidance first, then command surfaces, then done_prepare blocker grouping and smoke coverage.

## CHK-001

Create a central review-assurance guidance projection, likely in `packages/main/src/core/review-assurance-floor.ts`, that consumes the existing canonical status/binding data instead of re-implementing the gate. The projection must expose reason code(s), current material/story binding, required legal writer or host lane, fallback eligibility, and cannot-auto-sign explanation. It must be display-only and must not write review, delivery, host verdict, fallback, Authority, or production evidence.

Acceptance evidence: a focused fixture with countable first-round findings and review-assurance triggers renders the canonical guidance, including current material binding and legal-writer/cannot-auto-sign text.

## CHK-002

Thread the shared guidance into early command surfaces before DONE: `session_brief` / next-step readiness, `review_escalation_status`, `story_advance --phase=TEST` advisory output through `transition-effects.ts`, and `done_prepare --dryRun`. Human output should be explicit; JSON output must remain parseable and should either omit guidance from stdout or include it as structured fields only where existing contracts allow.

Acceptance evidence: smoke proves a triggered story surfaces review assurance before DONE from `session_brief` and `done_prepare --dryRun`, and `story_advance --phase=TEST` shows it as advisory rather than a TEST gate.

## CHK-003

Improve done_prepare blocker classification for review assurance, missing evidence, generated metadata, stale material, and cannot-auto-sign cases. The output should group blockers by action type and separate owner-runnable commands from reviewer/host/human-approved fallback paths. It must explicitly warn that owner/main cannot self-sign reviewer pass, host verdict, degraded fallback, delivery-check, or delivery-waiver evidence.

Acceptance evidence: focused smoke checks done_prepare missing review-assurance blocker guidance, generated metadata does not suggest committing unrelated user changes, and cannot-auto-sign guidance appears for host verdict, degraded fallback, reviewer evidence, and delivery checks.

## Verification

Run `npm --prefix packages/main run build`, `npm --prefix packages/main run test:review-assurance-surfacing-smoke`, and full `lattice validate --story=B-eb92 --json`. Record verification intent evidence for all CHK lanes, then use normal review, delivery, quorum, and DONE gates.
