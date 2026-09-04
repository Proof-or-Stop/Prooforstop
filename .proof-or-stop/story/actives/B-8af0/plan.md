# B-8af0 plan

## CHK-001 — Reproduce and close the remaining candidate-routing freshness leak

Canonicalize the review-inventory barrier projection by sorting the selected candidate `{path, contentHash}` rows, while retaining `schemaVersion`, `mode`, `scanEscalationReason`, and `corpusDigest`. Do not alter the full candidate artifact digest verifier. The real handler smoke must distinguish equal reordered candidates (OPEN) from changed selected path/content (INVALIDATED with candidate-routing mutation).

## CHK-002 — Guard malformed candidate input at the gate boundary

Make candidate artifact verification safe for persisted unknown JSON before any field or array access. Carry an explicit invalid-artifact marker from scope capture into `persistInvalidationIfDrifted`, add the typed `OPEN_REVIEW_INVENTORY_INVALID_CANDIDATE_ARTIFACT` invalidation reason, and render it in status. Update the review-inventory decision once the known-incomplete case is closed. Test string and object non-array candidates on the real handler path and separately prove an artifactDigest mismatch remains rejected.

## CHK-003 — Add the end-to-end routing-neutral regression fixture

Reconstruct the historical regression from immutable commit `2c9395fa22e18ca40ba3ee47d9d40c2ad748e009`; never apply or pop a stash. Create `story/<id>`, commit an unrelated test-only change, require nonempty `main...HEAD` changed paths, reroute, and assert both stored epoch state and rendered handler status are exactly OPEN.

## Verification order

First make each new handler-smoke assertion fail against the current source. Then implement the canonical barrier and structural guard, build `packages/main`, run the focused handler, epoch, and candidate-routing smokes, run TypeScript checks, and run the root suite once at a stable head before TEST.
