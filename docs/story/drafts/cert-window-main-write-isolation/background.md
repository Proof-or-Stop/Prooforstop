## Trigger Event
B-5952 CertificationWindow CW-002 was admitted at 2026-08-31 14:12:49+01 and its DONE-required run ended at 14:16:29+01. Main accepted commits 07a60fce1b at 14:14:22 and 771f88886c at 14:15:00 while the root full test suite was running. The candidate materialHash remained unchanged, build passed, and npm test exited 1.

## Key Insights
Certification admission captures expectedMainSha but does not currently prevent or clearly classify concurrent main writes during the heavy run. One occurrence is medium because cancelling the window, merging main, resetting the TEST anchor, and re-running once can recover. Repetition or a consumed false verdict upgrades this to high.

## Solution Tradeoffs
Holding the main-write lock for the entire suite gives strong isolation but may block unrelated Story initialization for minutes. A bounded expectedMainSha drift check before and after the heavy command avoids a long lock but must refuse the receipt deterministically and preserve clear retry guidance.

## Conversational Texture
This was discovered while deliberately avoiding duplicate full-suite retries. gap_log could not record it because the existing B-META provenance chain failed with invalid_binding_shape, and bug_report is unavailable in DEV, so this draft is the traceable deferred backlog record.
