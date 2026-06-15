## Trigger Event
On 2026-06-15, after B-3010 and token-cost work, the user asked how many tokens were actually pushed to LLM providers. Lattice could report local mechanical checks and prompt-size estimates, but not exact provider billing usage for Codex/Claude host work.

## Key Insights
The correctness issue is not token optimization itself; it is observability and evidence precision. Lattice must only record true provider-reported usage as true usage, mark unavailable usage explicitly, and never promote local ledgers into Authority Server completion without receipt-backed proof.

## Solution Tradeoffs
Keep the first step as a document-only execution plan. The future implementation should add a runtime usage ledger and query surfaces, reuse existing provider execution and budget-meter seams, and avoid saving raw prompts or transcripts. Authority Server integration remains a separate receipt-backed path.

## Conversational Texture
This is a high-risk lifecycle/host/Authority-adjacent planning task. The execution document must follow: do not optimize for optimization, do not optimize arbitrarily, only fix real correctness issues, and follow consistency of logic.
