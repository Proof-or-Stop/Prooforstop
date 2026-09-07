## Trigger Event
On 2026-09-07, B-7abb BUG-CRITIC-PROVENANCE-001 reproduced an official topology-critic dispatch refusal because every implementation commit used the user-required Harmonynet identity instead of a legacy role author. All required review lanes completed, but the inventory critic could not launch and REVIEW remediation could not proceed.

## Key Insights
The same registered critic currently serves two different contracts. Inventory completeness consumes signed current-run, cutoff, read evidence and per-finding dispositions; topology certification separately consumes business-author and implementation provenance. A shared launch path incorrectly requires topology provenance for inventory-only review.

## Solution Tradeoffs
Introduce explicit purpose isolation with current signed inventory bindings while leaving topology admission and its independent provenance untouched. Reject role-author spoofing, username allowlists, silent fallback, direct Story JSON mutation and lifecycle bypass. Only the dispatch, run, inventory, prompt and regression surfaces required for this boundary belong here.

## Conversational Texture
The user asked why work had not started and what they needed to do after reviewing this concrete solution. They want the already authorized blocking repair executed without repeated permission requests or unrelated scope expansion, followed by B-7abb and B-03b7 completion before B-e6d9. This is local-only work, not remote publication authority.
