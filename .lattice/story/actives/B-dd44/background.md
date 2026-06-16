## Trigger Event
On 2026-06-16, after the ledger was wired into the Claude dispatch path (B-0f7c) and a parallel feasibility scout confirmed this is a feasible low-risk slice, the user authorized implementing the remaining ledger touchpoints one story each. This is Touchpoint 4 (fail-closed budget).

## Key Insight
The preflight prompt-size estimate already exists (selectEstimate/bytesCharsEstimator) and the gated Claude dispatch seam already records it before spawn (recordDispatchPreflight in runClaudeCodeRealLeafDispatch). A hard-budget check fits exactly there: read a configured hard-budget token ceiling (env var, dual-brand LATTICE_/KOALA_), and if the estimate exceeds it, write a decision.kind=blocked record (budgetPolicyId, reasonCode) and SKIP the provider spawn (fail closed). record.ts already models decision.kind='blocked', budgetPolicyId, and reasonCode. The spec is explicit: never invent a budget — when none is configured, proceed with budgetPolicyId=null (today's behavior); only an explicit configured hard budget that is exceeded blocks.

## Tradeoff
Blocking is a deliberate control-flow change, but it is bounded: it happens ONLY when the operator sets the hard-budget env var AND the preflight estimate exceeds it. With no budget configured (the default) or the ledger flag OFF, dispatch is byte-identical to today. We keep the pure block-record builder + policy resolution in the usage-ledger module (zero cross-module imports) and make the lattice-dispatch.ts change a minimal gated guard, mirroring the B-0f7c seam. We accept claude-host-only enforcement now (other hosts have no live call).

## Conversation Texture
The user asked to open one story per remaining ledger item and solve them via the Lattice flow. A parallel scout rated this feasible/low-risk, touching no logic outside the seam. This follows B-253e/B-08a1/B-a5c9/B-97df/B-0f7c. Authority receipt and default-on are the sibling stories; codex/gemini real usage is blocked (those hosts have no live invocation).
