## Trigger Event
On 2026-06-22, review of packages/main/src/handlers/quorum-submit.ts showed quorum_submit generates deterministic runIds (storyId-q-rN) and re-emits verdicts on every call, so a second invocation for the same story at the same material silently appends duplicate verdicts to runIds that already carry a passing quorum. This is the improvement point: quorum_submit should prevent duplicate submission for an existing runId.

## Key Insights
The runId scheme is deterministic per round, so re-running quorum_submit always collides with prior runIds. listVerdicts already exposes existing verdicts and summarizeVerdicts already counts duplicateVerdicts, but the handler never checks before emitting. The guard should refuse when a planned runId already has a verdict at the SAME materialDigest (a true no-op duplicate), while still allowing a fresh quorum after the material changes (a different materialDigest, e.g. after a real re-review). The existing quorum-submit smoke test's rounds-knob case re-submits overlapping runIds at the same material and therefore currently exercises the very duplication this story prevents; it must be restructured.

## Solution Tradeoffs
Material-aware refusal (refuse only on the same runId plus materialDigest) is preferred over a blanket refuse-on-any-existing-runId, because a blanket rule would false-block a legitimate re-quorum after a material change and re-review. An idempotent silent skip was considered but rejected: the operator wants an explicit refusal so a double-submission is surfaced, consistent with the handler's existing refusal style (the REFUSAL constant). The guard is placed after materialDigest is computed and before the emit loop.

## Conversational Texture
The operator asked: quorum_submit should prevent duplicate submission for an existing runId. The deliverable is a small guard plus a clear refusal message that names the colliding runId(s), with smoke-test coverage for both the refusal at the same material and a clean re-quorum after a material change.
