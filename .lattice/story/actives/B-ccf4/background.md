## Trigger Event
On 2026-08-31, the operator asked for a concrete Markdown execution plan after confirming that the repository currently provides a static fast focus and an unfiltered full validation set but no Story-relevance intermediate tier.

## Key Insights
Tier policy and tier membership must be separated: policy defines the stable meaning of fast, intermediate, and repository-full, while each Story dynamically derives membership from changed files, declared test files, pinned verification commands, dependency and runtime coverage evidence, and risk signals.

## Solution Tradeoffs
The plan should prefer a small hybrid selector that reuses existing rename-aware diffs, checklist evidence, validation identity, and coverage infrastructure. Unknown or stale impact data must widen execution rather than silently omit tests, and repository-full validation remains exhaustive until observed calibration proves any later policy change safe.

## Conversational Texture
The operator wants a simple and fast mechanism, not a permanently hand-maintained tier list. The document therefore needs an immediately usable MVP, transparent selection explanations, conservative fallback behavior, and staged improvements without claiming that a dynamic selector already exists.
