## Trigger Event
On 2026-06-16, after story B-4bf8 corrected the token-accuracy gaps in the LLM usage ledger execution plan (docs/requirements/decisions/lattice-llm-usage-ledger-execution-plan.md), the user authorized starting the actual implementation. No ledger code exists yet — confirmed there is nothing under packages/main/src that writes .lattice/usage/llm-usage.jsonl. This story is the first implementation slice.

## Key Insight
The spec explicitly mandates narrow slices and a phased rollout (6 implementation touchpoints, 6 rollout phases). Slice 1 — the JSONL schema + validator + append-only hash-chained writer + runtime-artifact registration — is the self-contained foundation every later slice builds on. It must record the four-field cache-aware usage shape (inputTokens uncached-remainder, outputTokens, cacheCreationInputTokens, cacheReadInputTokens; no stored totalTokens), the usage.source discriminator, correlation ids minted before dispatch, story/role attribution, privacy (no raw content), and a tamper-evident hash chain — all behind an opt-in flag so it stays inert until later slices wire providers and budgets.

## Tradeoff
Building only the writer foundation (later slices add live model integration, preflight estimation, budget logic, and the signed-receipt path) keeps this story small, testable, and low-risk, at the cost of the ledger being inert (opt-in; nothing writes real records yet) until follow-up stories. We accept an unused-but-correct foundation over a big-bang implementation the spec warns against. The chosen file path .lattice/usage/llm-usage.jsonl is runtime state and must be classified materialHash=exclude/volatile/repairable so it never pollutes evidence or gate hashes.

## Conversation Texture
The user said '开始开发吧，使用Lattice CLI create Story流程，走完整个生命' and, when asked about scope, chose the foundation slice (recommended) over a budget-inclusive or all-in-one story. This follows B-1477 (original plan) and B-4bf8 (accuracy fixes). Subsequent slices, covering the remaining spec touchpoints, are separate future stories.
