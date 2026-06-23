# B-e37e Plan

## CHK-001 Detect and consume runner jobs SSE as a notification hint

Add an authenticated `AuthorityClient` runner jobs stream helper for `GET /v1/runners/{runnerId}/jobs/stream`. It should parse `jobs.available` SSE events, tolerate heartbeat comments, and return a bounded hint result such as `available`, `empty`, `unavailable`, or `timeout` without exposing raw response secrets. `runLatticeAuthorityControlPlaneOnce` should call the helper after runner heartbeat and before the existing signed claim request. The helper may accelerate when a server publishes a matching job, but it must only trigger the existing claim path; it must not construct or execute a job from SSE data.

Verification: extend `authority-runner-client-smoke` to prove the stream GET happens before claim when available, a `jobs.available` event triggers claim, and SSE alone does not set `claimedJobId`.

## CHK-002 Preserve auth, retry, and host-neutral provider boundaries

Use the same customer API key source as protected Authority reads. All stream failures, HTTP errors, timeout, non-SSE responses, malformed SSE data, and one-shot empty snapshots fall back to the existing signed claim path with redacted diagnostics. The claim envelope must continue using `options.runnerProvider`; no provider-specific shortcuts should be introduced.

Verification: add smoke cases for 401/403 or text error body containing secret-like strings, timeout/disconnect fallback, non-SSE fallback, and provider-neutral claim payload. Assertions must prove diagnostics omit `Authorization`, `Bearer`, and the raw test customer key.

## CHK-003 Document server dependency and client fallback contract

Update CLI-facing docs to state that runner jobs SSE is an optional notification-latency improvement when the Authority server supports long-lived `jobs.available` push. Polling/signed claim fallback remains the compatibility path, and a `jobs.available` event is not a lease, receipt, `authorityDone`, `fullAuthorityDone`, or `productionDone`. Also keep the canonical root note clear: new mutating work happens in `/Users/jek/Documents/Work/proofbound`; `/Users/jek/Documents/Work/Orchestrate` is retired read-only legacy evidence.

Verification: docs grep/readback plus the focused smoke output. Do not document server-side implementation internals or suggest Lattice CLI can generate server-owned credentials.

## Combined Scenarios

- Long-lived server stream + queued matching job: stream returns `jobs.available`, CLI immediately attempts signed claim, and only claim success populates claimed job state.
- Old one-shot snapshot + no queued job: CLI treats the stream as empty/unavailable and proceeds through existing claim fallback without hanging.
- Stream auth failure + secret-bearing body: diagnostic is redacted and fallback behavior does not print customer key or Authorization material.
- Nonmatching provider: SSE payload does not override `options.runnerProvider`; claim still asks for the configured provider only.
- CLI story + server story: this story consumes the server contract but does not assert server deployment, production readiness, or provider execution speed.

## Rollback Path

If SSE consumption causes live runner regressions, remove the pre-claim stream wait call from `runLatticeAuthorityControlPlaneOnce` and leave the existing register/heartbeat/claim flow intact. Because SSE is only a hint, rollback does not require data migration or server changes; the compatibility path is the current signed claim behavior.
