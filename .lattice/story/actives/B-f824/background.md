## Trigger Event

On 2026-07-23 the B-956f closeout hit a hard DONE failure: done_prepare threw convergence invariant failed with unchangedSuiteExecutions=1. Telemetry in .lattice/story/actives/B-956f/process-events.jsonl shows the round 18:10:20 window contained an executed validation_terminal for cmdSet 34090591 at 18:25:19 (REVIEW phase, reviewer lane), an executed terminal for a different identity 15aa0ab1 at 18:36:10 which evicted the single-slot PASS receipt in test-evidence.json, and a forced re-execution of 34090591 at 19:02:20 (TEST phase, closeout validate) because reuse found a receipt bound to the wrong identity. The only recovery was a ceremony TEST-DEV-REVIEW bounce at 19:05 to move the window anchor.

## Key Insight

The invariant introduced by B-10b0 treats every executed terminal in the window as closeout thrash, but the same derivation already distinguishes observable versus blocking reviewer re-attestation via reviewerReattestations and postTestReviewerReattestations. Applying the same phase-anchored split to suite executions - blocking only per-group duplicates at or after the current TEST entry plus contradictory reused terminals - preserves the anti-thrash guarantee for the closeout path while making reviewer independent verification during REVIEW non-blocking telemetry. The TEST-entry timestamp is framework-written and mechanically trustworthy, so no new self-declared attribution field is needed, which matches the EXP-001 finding that caller identity is not mechanically distinguishable.

## Tradeoff

Alternative designs considered: writer-attribution fields on validation_terminal events depend on self-declared caller identity that EXP-001 proved unverifiable; an N-per-lane execution allowance weakens the invariant globally and lane identity is not recorded on terminals; a multi-slot receipt store fixing eviction at the root touches every test-evidence.json consumer (DONE gate, freshness, drift classification) and is deferred as a follow-up. The chosen split accepts that pre-TEST redundant executions remain possible and merely observable, trading some waste-detection strictness for eliminating a permanent DONE deadlock that contradicted review policy.

## Conversation Texture

The operator reported that during the B-956f closing two REVIEW-round reviewer lanes each legitimately ran lattice validate --story on the unchanged merged tree because independent verification is the review policy, plus done_prepare ran its own internal re-execution, and the window was poisoned permanently. The requested direction was to reproduce first with the flow-stability-smoke patterns which already assert this invariant, then fix counting so reviewer-attributed validates stop blocking DONE while closeout-path duplicates keep failing fast.
