## Trigger Event
On 2026-06-23, after validating the Lattice Authority Server SSE endpoints, we found that /v1/runners/{runnerId}/jobs/stream is currently only a snapshot event and that true job-available push requires server support plus a CLI consumer. The operator then confirmed that new Lattice CLI work must be opened from canonicalRoot /Users/jek/Documents/Work/proofbound, not the retired /Users/jek/Documents/Work/Orchestrate root.

## Key Insights
The CLI should not try to create authority by itself; the server remains the queue authority and the CLI still has to claim a job with the existing signed runner flow. SSE is only a faster notification channel that can reduce waiting and polling, so correctness depends on preserving claim/release/idempotency behavior and treating SSE events as hints rather than ownership proof.

## Solution Tradeoffs
Prefer a narrow authority runner client change: listen to jobs.available SSE when configured and supported, then call the existing claim path; on connection failure, timeout, snapshot-only behavior, or auth errors, keep the existing polling/claim behavior with clear diagnostics. Do not implement the server long-lived stream in this CLI story, do not change receipt or gate semantics, and do not add arbitrary multi-tenant behavior.

## Conversational Texture
The operator wants the flow to become simpler and faster without another round of over-engineering. The work should produce concrete behavior that a developer can run, while staying honest that faster notification is not faster provider execution and that server-side push support remains a separate dependency.
