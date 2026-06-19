## Trigger Event
On 2026-06-19, story B-4033 reached TEST with full-3x2 review + delivery-check but could not enter DONE: the DONE Evidence-freshness gate kept failing because lattice validate force-exits with "validate stuck: 300 seconds without output; forcing exit" and therefore never re-stamps test-evidence.materialHash. This blocks DONE for all stories, not just B-4033.

## Key Insights
lattice.config.json validate.commands now includes node packages/main/dist/tasks/review-pass-discard-smoke.js and node packages/main/dist/tasks/init-window-data-loss-smoke.js (added by recent merges to main). Both produce no console output and run past 300s, so validate hits its no-output watchdog and force-exits. Verified during diagnosis: spawning dist/cli.js story_create against an isolated mkdtemp temp repo completes in ~2-3s (so the first story_create spawn and the global main-write-lock are NOT the cause); the hang is later in the smoke flow (a subsequent spawn, a git operation such as git clean, or a wait). The exact hang line must be pinpointed in DEV by tracing each smoke step.

## Solution Tradeoffs
Two complementary fixes: (1) diagnose and fix the actual hang in the two smokes so they complete deterministically (preferred — restores their regression value); (2) make validate resilient with a per-command bounded timeout that marks the offending command FAILED (loud, diagnosable) instead of a silent whole-suite force-exit that leaves freshness unstamped. Prefer fixing the smokes; the per-command-timeout hardening prevents any future single hang from silently blocking all DONEs. Avoid simply deleting the smokes (loses coverage) unless they are proven redundant.

## Conversational Texture
The operator hit this while building the parallel-decomposition gate program and asked to fix the validate deadlock first because it blocks the whole program's DONE-merges (S2-S5 would hit the same wall). The value is that lattice validate can complete again and stories can reach DONE; acceptance is validate runs to completion (no force-exit) and a deliberately-hung command surfaces as a clear per-command failure.
