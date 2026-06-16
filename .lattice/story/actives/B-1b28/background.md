## Trigger Event
On 2026-06-16, after the budget (B-dd44) and Authority (B-fd64) slices, the user authorized the remaining ledger touchpoints. A parallel scout rated this default-on flip feasible (1-line change in writer.ts) with the existing escape hatch, recommending it proceed since the full ledger smoke suite passes. This is the last planned ledger slice.

## Key Insight
isUsageLedgerEnabled() in writer.ts currently returns false when LATTICE_USAGE_LEDGER (fallback KOALA_) is unset; the parser already maps 0/false/off/no to disabled. Flipping the unset default to true makes the ledger record by default while keeping an explicit-OFF escape hatch automatically. The behavioral changes this turns on for every Claude dispatch — recording ledger records and running the host with --output-format json — were both already hardened in B-0f7c: parse failure falls back to raw stdout text (dispatch result unaffected) and every ledger call is wrapped in try/catch so a ledger error never breaks dispatch. Crucially, the B-dd44 budget block is separately gated on LATTICE_HARD_BUDGET_TOKENS, so default-on does NOT block any dispatch.

## Tradeoff
This is the one slice whose default-on observable effect reaches every user, so the load-bearing safety property is the escape hatch: LATTICE_USAGE_LEDGER=0 must restore the exact legacy behavior (writer no-op, original spawn args, raw stdout, inert budget guard) byte-identically. We accept turning recording on by default — the prior slices made the seam safe and degrade-gracefully — in exchange for the ledger actually capturing usage without each operator opting in. We do NOT change any seam/budget/authority logic here; only the default of the one flag.

## Conversation Texture
The user asked to open one story per remaining ledger item and solve them via the Lattice flow; this is the last (codex/gemini real usage is blocked — no live invocation). Follows B-253e/B-08a1/B-a5c9/B-97df/B-0f7c/B-dd44/B-fd64. The scout flagged this medium-risk (behavioral) but clean given the existing fallbacks.
