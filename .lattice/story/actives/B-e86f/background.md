## Trigger Event
On 2026-07-05 the operator ran a manual demo of the memory-baseline instrument: 3 small-profile replays returned byte-stable digests (expectedIdsFoundRate 1.0), and a 1-byte tamper of records.jsonl in an isolated copy returned status: fail (recordsDigestStable: false, staleDetected: true) while the surface score stayed perfect. The operator then requested a supporting execution-plan document for systematizing this into a batch campaign, and approved landing it after review.

## Key Insights
The verdict-follows-evidence-chain property (a tampered corpus can still answer all 1,000 questions correctly, yet the verifier refuses) is currently proven only anecdotally. The draft plan went through an adversarial self-review (3 lenses x per-finding refutation; 21 surviving findings resolved in rev 2), which caught a load-bearing defect: the seed-swap tamper class was a no-op because seed is content-inert in buildBaselineRows — freezing it would have mechanically falsified H2 with a spurious instrument defect. rev 3 adds cross-vendor (Codex) roles: red-team at M0, standard host-2 story review, replication at M4, cross-vendor M5 scoring; outcome-judging stays deterministic code.

## Solution Tradeoffs
Land the plan as a docs-only story first (pre-registration discipline: protocol semantics reviewed before any harness code exists), rather than bundling doc + M0 implementation in one story. Keeps the review surface small and lets the M0 story bind to a committed, hash-referencable plan. The plan deliberately reuses the existing generate/verify CLI and campaign patterns (recovery-runner, run-pilot) instead of building new instrumentation.

## Conversational Texture
The operator repeatedly pushed back on optimization-for-its-own-sake and on unclear task framing; the plan therefore leads with purpose (calibrate the measuring stick), an explicit claim boundary (proves the INSTRUMENT, not agent quality or memory value), and a no-overclaim rule. The operator's fairness question (should Codex judge?) is answered in section 6.5: models never judge outcomes; deterministic code does.
