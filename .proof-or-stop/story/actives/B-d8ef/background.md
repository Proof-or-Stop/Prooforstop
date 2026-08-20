## Trigger Event
2026-07-09 follow-up after B-7438 DONE and B-eb92 Round 5 reviewer receipt showed that host availability proof can still be misleading: Claude --print is valid but silent until final output, Claude stream-json needs --verbose for observable progress, Codex login status can hide token_invalidated failures, and agy --prompt-file is not accepted by the installed agy CLI.

## Key Insights
The current review_host_availability_probe proves executable path plus --version responsiveness, not reviewer execution readiness. That is enough to avoid self-reporting a single-host environment, but not enough to choose a safe reviewer launcher or to prevent long no-output waits. Availability, auth/execution readiness, and observable progress need separate structured fields.

## Solution Tradeoffs
A full live LLM call during every probe would be expensive and noisy, but a bounded noninteractive smoke with canonical launcher metadata can catch wrong flags, missing auth, token invalidation, and silent launcher modes. The gate should consume execution-ready counts for non-human degraded fallback while preserving lower-assurance explicit-human-approval.

## Conversational Texture
The user supplied concrete shell transcripts from another session: Claude --print alone is not an invalid option, but reviewer work should use claude --print --verbose --output-format=stream-json, optionally with --include-hook-events. This should become a mechanical contract so future agents do not rely on memory or wait through silent commands.
