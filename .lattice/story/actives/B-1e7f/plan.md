# B-1e7f Plan: Story-scoped Authority job claims

## Goal

Make the Lattice CLI declare the intended story identity inside the signed Authority job claim payload for story-scoped live runner flows. The Authority Server already enforces optional `storyId` and `jobId` selectors; this story wires the CLI side so stale queued jobs from discarded or unrelated stories cannot be leased by accident.

## Constraints

- Do not change Authority Server code in this story.
- Do not add queue purge, cancel endpoints, retry loops, or new multi-tenant behavior.
- Keep generic broad runner claims valid when no story selector is available.
- Keep SSE as advisory only; signed `POST /jobs/claim` remains the ownership boundary.

## CHK-001

Update the runner claim contract so `JobClaim` accepts optional `storyId` in addition to the existing optional `jobId`. The selector must live inside the signed claim payload, not in query params, stream metadata, or unsigned request fields.

Verification:
- Contract smoke accepts signed claims containing `storyId` and `jobId`.
- Contract smoke still accepts broad claims with no selector.
- Client smoke proves selector fields are serialized in the signed claim shape.

## CHK-002

Update both live claim paths that know the requested story:

- `authority-job-loop-live.ts` autopilot/live job loop claim.
- `authority-runner.ts` disabled-control-plane live runner claim.

Each path should include `storyId` only when the flow is story-scoped and has a story id. The implementation should not infer ownership from SSE hints.

Verification:
- Live job-loop smoke observes `claim.storyId` for the requested story.
- Regression smoke models a stale queued job from another story and verifies the current-story flow does not accept that stale job as success.
- Runner client smoke observes `authority_enforce_runner` story-scoped claims include `storyId`.

## CHK-003

Implementation rollup: keep the code change to the three declared core files and the existing focused smoke files. This item exists because `plan_skeleton --write` added a generic implementation item after INIT_CHECK; it does not expand the story scope beyond CHK-001 and CHK-002.

Verification:
- The diff contains no queue purge, cancel endpoint, retry-loop workaround, or server-side change.
- Claim selectors remain signed intent fields.

## CHK-004

Verification rollup: run focused smokes that cover contract shape, live loop behavior, and runner client behavior. This item exists because `plan_skeleton --write` added a generic verification item after INIT_CHECK; it does not add new product scope beyond CHK-001 and CHK-002.

Verification:
- Focused smoke commands pass.
- The stale other-story queued job regression is covered.
- SSE remains advisory in the asserted behavior.

## Execution Order

1. Patch claim schema/types.
2. Patch live claim payload builders.
3. Patch focused smokes and add the stale queued other-story regression.
4. Run focused tests, build if required by the story gate, then complete review and DONE normally.
