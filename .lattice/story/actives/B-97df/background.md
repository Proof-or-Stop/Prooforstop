## Trigger Event
On 2026-06-16, after B-a5c9 (estimate path) landed, the user directed: keep the token module modular, do not modify other logic code, and run via the Lattice CLI. Of the ledger's remaining slices, only status & diagnostics (spec Touchpoint 5) can be done entirely inside the usage-ledger module; the dispatch-wiring, budget, and receipt slices all necessarily touch other logic and are therefore excluded by that constraint.

## Key Insight
summary.ts already selects the latest non-superseded record per ledgerCallId+attemptId and buckets by source (provider-reported vs prompt-size-estimate vs unavailable) with unknown never coerced to 0. This slice layers grouped aggregation on top — rolling usage up by storyId, phase, agentType/role, model, and provider so an operator can read 'how much did story X / model Y consume' — plus a pure cost projection that takes an INJECTED price table (no hardcoded prices; cost only when a table is supplied, recorded against a pricingRef). It is read-only and feeds no gate. Keeping the reporter a runnable task that reads a ledger file path (rather than a registered CLI command) lets the whole slice stay inside the module with zero changes to other Lattice logic.

## Tradeoff
Staying strictly in-module means the reporter is a runnable task over a ledger file, not a first-class 'lattice usage' command — registering a command would touch the command registry (other logic), which the user explicitly forbade. We accept the slightly less ergonomic entry point to preserve zero cross-module coupling and the no-other-code constraint; a first-class CLI command can be a separate later story if wanted. Cost stays pluggable (injected price table) so the module never hardcodes prices or couples to a billing source.

## Conversation Texture
The user said '这个token计算模块化，不要修改其他逻辑代码，使用Lattice CLI 来执行' — an explicit modularity + no-other-code constraint, to be executed through the Lattice story flow. This follows B-253e (writer foundation), B-08a1 (provider adapters), and B-a5c9 (estimate path); the dispatch-wiring, budget, and receipt slices remain separate future stories outside this constraint.
