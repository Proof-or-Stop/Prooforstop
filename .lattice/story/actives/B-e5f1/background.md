## Trigger Event
During B-022e on 2026-08-31, done-prepare-closure-heartbeat-smoke reached passing validate and done_required_validate commands, then done_prepare blocked because the generated certification-window.json change was classified as non-closeout metadata.

## Key Insights
CertificationWindow is now required before heavy certification, and its signed state may move while validation runs. The closeout classifier currently treats that expected movement as foreign material even though the validation commands themselves pass.

## Solution Tradeoffs
The follow-up must preserve fail-closed clean-tree protection. It should narrowly decide whether a validation-owned CertificationWindow transition is closeout metadata, rather than broadly allowing certification files or ignoring dirty-tree evidence.

## Conversational Texture
This issue was deliberately deferred from the identity cutover because it concerns certification and closeout policy, not naming. The operator expects a separately reviewed fix with a direct regression test and no weakening of DONE safety.
