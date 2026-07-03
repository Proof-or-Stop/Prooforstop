## Trigger Event
On 2026-07-03, after B-a4f7 proved new DONE experience can enter inert candidate playbooks, the user requested closing the remaining future work: historical 1400+ seed backfill and trial/matched-control/timer automatic experiments.

## Key Insights
The existing primitives already support digest-bound seed observe, proposal staging, candidate approval, explicit outcomes, and evidence activation. The missing correctness layer is an orchestration surface that can process all historical seeds safely and expose candidate trials without treating DONE success or mere candidate existence as helped evidence.

## Solution Tradeoffs
Prefer host-neutral CLI commands that are dry-run by default, digest-bound, idempotent, and limited by reviewed policy. Do not optimize for the sake of automation; only add behavior that fixes the real consumption gap while preserving candidate inertness and evidence-based activation.

## Conversational Texture
The user is frustrated by future-work wording and wants the product to actually consume accumulated experience. The implementation should prove concrete counts and behavior, not just add another document or flag that stays off forever.
