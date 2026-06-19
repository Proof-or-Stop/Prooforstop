## Trigger Event
During B-997b DONE closure on 2026-06-19, local 3x2 host verdicts were submitted with custom run ids, but autopilot_review_status without runId showed default-run with zero verdicts. After main merges, host verdict materialDigest values became stale and DONE gave a long diagnostic that was correct but hard to operate.

## Key Insights
The gates were mostly correct: stale verdicts should not pass, and local host verdicts must not claim server-backed closure. The gap is operator visibility. A user needs one status view that shows all local review rounds and one DONE runbook that names exactly what became stale and what command comes next.

## Solution Tradeoffs
The conservative fix is diagnostic-only: improve summaries and runbook rendering without changing the review assurance predicate, server-backed proof semantics, or DONE rules. This keeps future roadmap waves and remote-proof work out of scope while making the existing local assurance floor easier to complete.

## Conversational Texture
The user asked why future roadmap waves exist and whether the CLI diagnostic issues should be fixed now. The answer is to protect the future roadmap as boundary context while immediately smoothing the current local non-authoritative closure path that caused confusion in B-997b.
