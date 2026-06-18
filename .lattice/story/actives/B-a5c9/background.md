## Trigger Event
On 2026-06-16, after stories B-253e (writer foundation) and B-08a1 (provider adapters) shipped, the user chose to build the low-risk estimate path next (over the higher-risk live-dispatch wiring). Coupling analysis confirmed the usage-ledger module currently imports zero other Lattice modules and is imported by zero code (only a one-line runtime-artifact-registry string entry). This slice must preserve that independence.

## Key Insight
The spec requires preflight token estimates to PREFER the provider count_tokens endpoint, fall back to a local tokenizer, then bytes/chars only when offline, recording an estimator confidence (high/medium/low) and binding the estimate to the exact model id (token counts differ across model versions). To keep the module decoupled and unit-testable, the count_tokens call itself is modelled as a PLUGGABLE injected function (the real HTTP binding lands in the later dispatch slice, where provider clients live); this slice provides the orchestration, the deterministic offline bytes/chars fallback (never tiktoken — it is wrong for Claude), and the record builder. An estimate is a diagnostic/preflight guard only: usage.source='prompt-size-estimate', it never counts as final usage, and a later provider-reported record supersedes it.

## Tradeoff
Modelling count_tokens as an injected interface rather than calling a provider API here keeps this slice pure, offline-testable, and zero-coupling — at the cost of the high-confidence path being inert until the dispatch slice injects a real count_tokens function. We accept a tested orchestration with a stub-able high-confidence path over coupling the ledger to a provider HTTP client now. The local fallback is intentionally a coarse bytes/chars heuristic (low confidence) so no one mistakes it for billing truth.

## Conversation Texture
The user asked to keep the module independent ('不要和其他模块耦合太高了') and, given the roadmap, chose the low-risk estimate path first. This follows B-1477 (plan), B-4bf8 (accuracy fixes), B-253e (writer foundation), and B-08a1 (provider adapters). Live-dispatch wiring, budget enforcement, the receipt path, and default-on remain later slices.
