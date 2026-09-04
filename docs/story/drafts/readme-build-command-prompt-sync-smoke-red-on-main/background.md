## Trigger Event

On 2026-09-04, while implementing B-af1b CHK-005, the implementer ran the roster-pinning smokes and found (finding B-af1b:F-004, low) that packages/main/dist/tasks/session-brief-prompt-sync-smoke.js fails on main and on the story branch alike: it asserts that README.md contains the literal build command npm --prefix packages/main run build, and README.md no longer does. The failure predates B-af1b, is unrelated to hook rosters, and was left untouched under the defect triage rule.

## Key Insights

The smoke pins a documentation promise: the README must tell a maintainer how to rebuild the CLI. Either the README section was rewritten and dropped the line, or the smoke's expectation is stale. Whichever is true, a DONE-required smoke that is red on main means every story sees the same red and learns to ignore it, which is how a real regression later hides behind it.

## Solution Tradeoffs

Restore the build command line to the README section the smoke reads, with the exec-bit note from docs/story/drafts/build-emits-non-executable-cli next to it, so the promise and the check agree again. The alternative of loosening the smoke keeps the README silent about rebuilding, which is the promise the smoke exists to protect.

## Conversational Texture

The owner expects the DONE-required suite to be green on main so that a red result always means something. This draft records a low-severity, out-of-scope failure with its repro and owner instead of fixing it opportunistically inside B-af1b.
