## Trigger Event
On 2026-08-25, B-45a0 entered TEST and its routine validation was green, but done_prepare reported pre_cert_inventory_not_finalized. The available TEST-safe review_inventory_finalize command was not surfaced, so the session incorrectly bounced through DEV and REVIEW.

## Key Insights
The missing receipt is a certification-completeness input, not a newly required reviewer assessment. review_inventory_finalize is already permitted in TEST when no open inventory epoch exists, while review_inventory_begin is REVIEW-only. The recovery UI must distinguish those commands.

## Solution Tradeoffs
Keep the existing receipt, CertificationWindow, phase, and single-use semantics unchanged. Do not auto-write evidence inside done_prepare. Instead surface the exact existing finalization command and add a regression that prevents an unnecessary lifecycle bounce.

## Conversational Texture
The desired operator experience is direct and unambiguous: a green TEST blocked only by missing PRE_CERT inventory should say what to run next, then retry. It must never imply that the feature needs another DEV implementation or reviewer cycle.
