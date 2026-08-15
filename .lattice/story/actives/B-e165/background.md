## Trigger Event
Descoped from B-fb7b (DONE 2026-08-15, merged as ba067c2f76). B-fb7b added a root pretest that bootstraps packages/utils; an in-story attempt to also harden concurrent builds drew four successive Codex cross-host MAJOR findings, so the hardening was explicitly deferred here by maintainer decision.

## Key Insights
Codex found four MAJOR correctness bugs in a hand-rolled mkdir build mutex plus a freshness heuristic: (1) an age-based stale-lock steal age-steals a LIVE long-running build; (2) the check-then-delete reclaim is a TOCTOU race letting two waiters both enter the critical section and one delete a successors live lock; (3) single-file mtime freshness misclassifies deleted-source orphans, partial builds, and tampered outputs as fresh; (4) existence-only reuse (the minimal form B-fb7b shipped) reuses a present dist with no freshness proof. Crash-safe concurrent-build mutual exclusion plus content-bound freshness is a real infrastructure problem, not a reactive patch.

## Solution Tradeoffs
Prefer a proven filesystem-lock library or an OS-advisory (fcntl/flock, auto-released on process death) lock over a hand-rolled mkdir mutex, eliminating the stale-reclaim race class. For freshness, use a content-bound build-binding over source content + config + deps + ALL outputs (require verifyBuildBinding before skipping; add a packages/utils binding) instead of mtime/existence. Consider one atomic, reader-safe publish path shared by the packages-main-build purity proof and the pretest.

## Conversational Texture
The maintainer descoped this to keep B-fb7b proportionate to its request (npm test should build utils first) and give concurrency dedicated design. The Codex findings are permanently recorded in the B-fb7b cross-host review; B-fb7b ships only the minimal existence-based bootstrap.
