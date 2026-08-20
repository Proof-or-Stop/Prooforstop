## Trigger Event
B-ce03 reached DONE on 2026-06-24 only after rolling back from TEST to DEV to acknowledge .lattice/story/actives/B-ce03/evidence/live-smoke-transcript.json, because the scope gate treated the TEST-generated live-smoke transcript artifact as out-of-scope while scope_contract_acknowledge is forbidden in TEST.

## Key Insights
The artifact is created by the supported live_smoke_transcript command and is story-scoped lifecycle evidence, not product source. The existing lifecycle artifact policy already allows evidence/transcript-diff.md but did not include evidence/live-smoke-transcript.json. The fix should extend the closed lifecycle relative-path set, not create a broad evidence directory exemption.

## Solution Tradeoffs
Registering this single relative path keeps fail-closed behavior for arbitrary nested evidence files while removing the broken TEST-phase recovery loop. A broad .lattice/story evidence exemption would be easier but unsafe because notes, ad hoc JSON, and unrelated nested artifacts would bypass scope review.

## Conversational Texture
The user asked to finish the remaining plan items in order after B-ce03. This item is a practical workflow papercut: the system required a proof artifact and then blocked it as out-of-scope, so the clean solution is a narrow classifier update with regression coverage.
