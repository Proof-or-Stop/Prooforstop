## Trigger Event
On 2026-07-25, review of the B-bf52 burn ledger found verification evidence records that were internally self-contradictory (F-049: command names gate-repeat-block-smoke.js while the same row's file field names convergence-breaker-smoke.ts; F-050 same shape) yet were accepted and counted as proof by the verification gates.

## Key Insights
The evidence-add path (handlers/checklist.ts) and refresh_stale (checklist.ts:1051-1077) both trust caller-authored assertions. refresh_stale copies command/result/note verbatim and only re-stamps head/material/storyFilesHash, never re-executing, so it re-certifies a stale pass onto changed material (F-045/F-046/F-047). The only binding predicate is intentRef string equality (verification.ts:46). Both defects are mechanically detectable without any schema change.

## Solution Tradeoffs
This story deliberately does the cheapest, zero-schema slice: an in-row contradiction check at write time plus making refresh_stale honest. The larger fixes — pinning a (command, selector) verification binding and having the tool execute it to produce receipts — are the next story and are out of scope here to keep this one small and shippable.

## Conversational Texture
The user wants the tool to make false-evidence mistakes impossible rather than relying on the agent remembering rules. This slice removes two mechanical channels through which false evidence enters the ledger today, and is the first concrete step after four cross-host requirement audits re-aimed the work at evidence integrity.
