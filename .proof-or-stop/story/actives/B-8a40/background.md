## Trigger Event
On 2026-09-06, B-bcae reviewer startup remained blocked after two supporting attempts. B-5190 exposed an unsafe shortcut, while B-6846 used frozen metadata wording that recursively triggered the same classifier before any reviewer run could start.

## Key Insights
The desired behavior is already represented by test-first commits 30f1f5e1da and 12363ef512, but read-only follow-up inspection found three additional causal prefixes and a mutant assertion that stopped after the first escaped witness.

## Solution Tradeoffs
Use neutral Story metadata, port the bounded segment-aware candidate, extend the causal-prefix set, and check each broad-filter mutant witness independently. Avoid broad text interpretation, exact sentence allowlists, and workflow changes.

## Conversational Texture
The user authorized the supporting repair until the requested Story reaches DONE. Progress must remain honest: discarded attempts are preserved as evidence, provenance comes from the dispatched implementer, and no reviewer or gate result is fabricated.
